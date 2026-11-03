import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { ReadRpcClient } from '../src/providers.js';
import { AgentApiClient } from '../src/agent-api.js';
import {
  finalTransaction, finalView, nearBalance, runAgentAction, type AgentAction, type AgentRunner,
} from '../src/agents.js';

const KEY = `naa_${'l'.repeat(43)}`;
const grant = { agentId: 'c'.repeat(64), token: `ngt_${'t'.repeat(43)}` };
const USD = 1_000_000n;

function agentApi(agent: Account) {
  type Op = { correlation_id: string; status: string; details: Record<string, unknown> };
  const operations = new Map<string, Op>(), byId = new Map<string, Op>();
  let sends = 0;
  const answer = (op: Op, status: string) => ({ correlation_id: op.correlation_id, agent_id: grant.agentId,
    type: 'native', status, failure_code: null, created_at: '', updated_at: '', dispatch_committed_at: null,
    grant: null, details: status === 'PROCESSING' ? { ...op.details, tx_hash: null } : op.details });
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body)); };
    const refuse = (status: number, code: string) =>
      reply(status, { errors: [{ status: String(status), code, layer: 'request', title: code }], meta: {} });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.headers['x-api-key'] !== KEY) return refuse(401, 'unauthorized');
    if (url.pathname === `/v1/agents/${grant.agentId}/wallet`) {
      return reply(200, { wallet_id: 'w1', near_account_id: agent.accountId, evm_account_id: null,
        solana_account_id: null });
    }
    if (url.pathname === '/v1/status') {
      const op = byId.get(url.searchParams.get('correlation_id') ?? '');
      return op ? reply(200, answer(op, op.status)) : refuse(404, 'not_found');
    }
    if (url.pathname !== `/v1/agents/${grant.agentId}/native/near/call`
      || req.headers['x-grant-token'] !== grant.token) {
      return refuse(404, 'not_found');
    }
    const key = String(req.headers['idempotency-key']);
    let op = operations.get(key);
    if (!op) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const call = JSON.parse(Buffer.concat(chunks).toString());
      sends++;
      const result = await agent.signAndSendTransaction({ receiverId: call.receiver_id, waitUntil: 'FINAL',
        throwOnFailure: false,
        actions: [actions.functionCall(call.method_name, call.args, BigInt(call.gas), BigInt(call.deposit))] });
      const reverted = typeof result.status === 'object' && result.status !== null && 'Failure' in result.status;
      op = { correlation_id: `op_${operations.size + 1}`, status: reverted ? 'FAILED' : 'SUCCESS',
        details: { method: 'near_call', chain: 'near', account_id: agent.accountId, target: call.receiver_id,
          method_name: call.method_name, tx_hash: result.transaction.hash } };
      operations.set(key, op);
      byId.set(op.correlation_id, op);
    }
    return reply(202, answer(op, 'PROCESSING'));
  });
  return { server, sends: () => sends };
}

function memoryOperations(): AgentRunner['operations'] {
  const rows = new Map<string, { id: string; state: string; evidence: unknown; held: string | null }>();
  const row = (id: string) => [...rows.values()].find(r => r.id === id)!;
  return {
    prepare: async (_agent, _kind, key) => {
      if (!rows.has(key)) rows.set(key, { id: randomUUID(), state: 'prepared', evidence: null, held: null });
      const { id, state, evidence } = rows.get(key)!;
      return { id, state, evidence };
    },
    lease: async id => {
      const r = row(id);
      if (r.held) return null;
      r.held = randomUUID();
      return { token: r.held, state: r.state, evidence: r.evidence };
    },
    release: async (id, _agent, token) => {
      if (row(id).held === token) row(id).held = null;
    },
    sent: async id => {
      assert.ok(row(id).state === 'prepared', 'only a prepared operation is sent');
      row(id).evidence = { sent: true };
    },
    transition: async (id, _agent, from, to, _hash, evidence) => {
      assert.ok(row(id).state === from, `a transition from ${from}`);
      Object.assign(row(id), { state: to, evidence });
    },
  };
}

test('an agent registers, deposits, stakes, is refused and withdraws through the Agent API, each proven on chain',
  { timeout: 300000 }, async () => {
  const wasm = (path: string) => readFile(resolve('../contracts/target', path)).catch(() => {
    throw new Error(`Build the contracts first: missing ../contracts/target/${path}`);
  });
  const [roundsWasm, tokenWasm, verifierWasm] = await Promise.all([wasm('near/rounds/rounds.wasm'),
    wasm('near/mock_ft/mock_ft.wasm'), wasm('intents/defuse.wasm')]);
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  let api: Server | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const owner = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const deploy = async (name: string, code: Uint8Array, init: Record<string, unknown>) => {
      const key = KeyPair.fromRandom('ed25519'), id = `${name}.${DEFAULT_ACCOUNT_ID}`;
      await owner.createAccount({ newAccountId: id, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto('30') });
      const account = new Account(id, provider, key.toString());
      await account.deployContract(code);
      await account.signAndSendTransaction({ receiverId: id, waitUntil: 'FINAL',
        actions: [actions.functionCall('new', init, teraToGas('100'))] });
      return id;
    };
    const ownerCall = (receiverId: string, method: string, args: object, deposit = 0n) =>
      owner.signAndSendTransaction({ receiverId, waitUntil: 'FINAL',
        actions: [actions.functionCall(method, args, teraToGas('100'), deposit)] });
    const verifier = await deploy('intents', verifierWasm, { config: { wnear_id: 'wrap.near',
      fees: { fee: 0, fee_collector: owner.accountId }, roles: { super_admins: [owner.accountId], grantees: {} } } });
    const token = await deploy('usdc', tokenWasm, { owner_id: owner.accountId });
    const rounds = await deploy('rounds', roundsWasm, { owner_id: owner.accountId, operator_id: owner.accountId,
      verifier_id: verifier, collateral_token_id: `nep141:${token}`, network: 'sandbox', price_threshold: 1 });
    const now = BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec);
    await ownerCall(rounds, 'add_series', { asset: 'btc-usd', decimals: 2, first_start: String(now),
      interval: '300000000000', price_window: '240000000000', close_before: '150000000000' });
    for (const holder of [rounds, verifier]) {
      await ownerCall(token, 'storage_deposit', { account_id: holder, registration_only: true }, nearToYocto('0.1'));
    }
    const agentKey = KeyPair.fromRandom('ed25519'), agentId = `agent.${DEFAULT_ACCOUNT_ID}`;
    await owner.createAccount({ newAccountId: agentId, publicKey: agentKey.getPublicKey(),
      nearToTransfer: nearToYocto('5') });
    const fake = agentApi(new Account(agentId, provider, agentKey.toString()));
    api = fake.server.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const port = (api.address() as { port: number }).port;
    const rpc = new ReadRpcClient(sandbox.rpcUrl, { timeoutMs: 10000, intervalMs: 50 });
    const client = new AgentApiClient({ url: `http://127.0.0.1:${port}`, key: KEY, timeoutMs: 60000 });
    const runner: AgentRunner = {
      deployment: { id: 'agent-chain', startBlock: '0', collateralTokenId: `nep141:${token}`, collateralDecimals: 6,
        contracts: { rounds, verifier } },
      api: client, view: finalView(rpc), transaction: (hash, sender) => finalTransaction(rpc, hash, sender),
      operations: memoryOperations(), waitMs: 60000,
    };
    const view = finalView(rpc);
    const agent = (await client.wallet(grant.agentId)).near_account_id;
    assert.equal(agent, agentId);
    const run = (key: string, action: AgentAction) => runAgentAction(runner, grant, { agent, key, action });
    const stake = (round: string, amount: bigint, minShares: string): AgentAction =>
      ({ kind: 'stake', series: 0, round, side: 'up', amount: amount.toString(), minShares });
    const balance = () => view(rounds, 'get_balance', { account_id: agentId });
    assert.equal(await nearBalance(rpc)(`nobody.${DEFAULT_ACCOUNT_ID}`), '0', 'an account never funded holds no NEAR');

    assert.equal((await run('token', { kind: 'register_token' })).state, 'confirmed');
    const near = BigInt(await nearBalance(rpc)(agentId));
    assert.ok(near > 0n && near < nearToYocto('5'), `the agent's final balance paid for gas and storage: ${near}`);
    await ownerCall(token, 'mint', { account_id: agentId, amount: (20n * USD).toString() });
    assert.equal((await run('rounds', { kind: 'register', contract: 'rounds' })).state, 'confirmed');
    assert.equal(await view(rounds, 'is_registered', { account_id: agentId }), true);

    const deposited = await run('in-1', { kind: 'deposit', amount: (9n * USD).toString() });
    assert.equal(deposited.state, 'confirmed', JSON.stringify(deposited.evidence));
    assert.equal(await balance(), (9n * USD).toString());
    assert.equal(await view(token, 'ft_balance_of', { account_id: agentId }), (11n * USD).toString(),
      'the money rests in rounds, not on the agent\'s NEAR account');

    const staked = await run('stake-1', stake('0', 5n * USD, '0'));
    assert.equal(staked.state, 'confirmed', JSON.stringify(staked.evidence));
    const stakeRecord = await view(rounds, 'get_stake', { series_id: 0, round: '0', account_id: agentId });
    assert.equal((stakeRecord as { amount: string }).amount, (5n * USD).toString());
    assert.equal(await balance(), (4n * USD).toString(), 'the stake was paid from the rounds balance');
    const sends = fake.sends();
    assert.equal((await run('stake-1', stake('0', 5n * USD, '0'))).state, 'confirmed');
    assert.equal(fake.sends(), sends, 'a rerun of a confirmed stake sends nothing');

    const greedy = await run('stake-2', stake('0', 2n * USD, (10n ** 18n).toString()));
    assert.equal(greedy.state, 'failed', 'the stake reverted, and the final transaction shows no stake');
    const early = await run('stake-3', stake('1', USD, '0'));
    assert.equal(early.state, 'failed', 'round 1 takes no stakes yet');
    assert.equal(await balance(), (4n * USD).toString(), 'a refused stake leaves the balance where it was');

    const out = await run('out-1', { kind: 'withdraw', contract: 'rounds', amount: (4n * USD).toString() });
    assert.equal(out.state, 'confirmed', JSON.stringify(out.evidence));
    assert.equal(await view(verifier, 'mt_balance_of', { account_id: agentId, token_id: `nep141:${token}` }),
      (4n * USD).toString(), 'the withdrawal lands in the agent account in NEAR Intents');
  } finally {
    api?.close();
    await sandbox?.tearDown();
  }
});
