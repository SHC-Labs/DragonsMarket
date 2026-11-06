import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { ReadRpcClient } from '../src/providers.js';
import { AgentApiClient } from '../src/agent-api.js';
import type { AgentAction } from '../src/agent-actions.js';
import { finalTransaction, nearBalance } from '../src/agent-chain.js';
import { dragonsPolicy } from '../src/agent-policy.js';
import { runAgentAction, type AgentRunner } from '../src/agents.js';
import { finalView } from '../src/chain-view.js';

const KEY = `naa_${'l'.repeat(43)}`;
const grant = { agentId: 'c'.repeat(64), token: `ngt_${'t'.repeat(43)}` };
const USD = 1_000_000n;

type Policy = ReturnType<typeof dragonsPolicy>;

function agentApi(agent: Account, policy: Policy) {
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
      if (!policy.native!.near.call.includes(call.receiver_id)) return refuse(403, 'native_method_denied');
      const allowed = policy.destinations.list.some(d => d.address === call.receiver_id);
      if (BigInt(call.deposit) > 0n && !allowed) return refuse(403, 'policy_destination_denied');
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

async function stopSandbox(sandbox: Sandbox) {
  const { childProcess } = sandbox as unknown as { childProcess: ChildProcess };
  const stuck = setTimeout(() => childProcess.kill('SIGKILL'), 5000);
  await sandbox.tearDown();
  clearTimeout(stuck);
}

function memoryOperations(): AgentRunner['operations'] {
  interface Row {
    id: string; state: string; evidence: unknown; held: string | null; sent: boolean; correlation: string | null;
  }
  const rows = new Map<string, Row>();
  const row = (id: string) => [...rows.values()].find(r => r.id === id)!;
  return {
    seen: async (_agent, key) => rows.has(key),
    prepare: async (_agent, _kind, key) => {
      if (!rows.has(key)) {
        rows.set(key, { id: randomUUID(), state: 'prepared', evidence: null, held: null, sent: false, correlation: null });
      }
      const { id, state, evidence } = rows.get(key)!;
      return { id, state, evidence };
    },
    lease: async ({ id }) => {
      const r = row(id);
      if (r.held) return null;
      r.held = randomUUID();
      return { token: r.held, state: r.state, evidence: r.evidence, sent: r.sent, correlation: r.correlation };
    },
    release: async ({ id }, token) => {
      if (row(id).held === token) row(id).held = null;
    },
    sent: async ({ id }) => {
      assert.ok(row(id).state === 'prepared', 'only a prepared operation is sent');
      row(id).sent = true;
    },
    transition: async ({ id }, from, to, { evidence, correlation }) => {
      assert.ok(row(id).state === from, `a transition from ${from}`);
      Object.assign(row(id), { state: to, evidence, correlation: correlation ?? row(id).correlation });
    },
  };
}

test('an owner funds an agent, which trades a market and stakes a round under its policy, each proven on chain',
  { timeout: 300000 }, async () => {
  const wasm = (path: string) => readFile(resolve('../contracts/target', path)).catch(() => {
    throw new Error(`Build the contracts first: missing ../contracts/target/${path}`);
  });
  const [roundsWasm, marketWasm, oracleWasm, tokenWasm, verifierWasm] = await Promise.all([
    wasm('near/rounds/rounds.wasm'), wasm('near/market/market.wasm'), wasm('near/oracle/oracle.wasm'),
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
    const collateral = `nep141:${token}`;
    const marketId = `market.${DEFAULT_ACCOUNT_ID}`, oracleId = `oracle.${DEFAULT_ACCOUNT_ID}`;
    const market = await deploy('market', marketWasm, { owner_id: owner.accountId, operator_id: owner.accountId,
      oracle_id: oracleId, verifier_id: verifier, collateral_token_id: collateral });
    await deploy('oracle', oracleWasm, { owner_id: owner.accountId, market_contract: marketId, verifier_id: verifier,
      collateral_token_id: collateral, bond: (5n * USD).toString(), window_ms: '3600000', panel_deadline_ms: '7200000',
      draw_window_ms: '3600000', council: owner.accountId, jury_size: 5, draw_delay_blocks: '2',
      min_proposal_ms: '3600000', operator_id: owner.accountId, network: 'sandbox', price_threshold: 1,
      no_decision_recipient: owner.accountId });
    const now = BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec);
    await ownerCall(rounds, 'add_series', { asset: 'btc-usd', decimals: 2, first_start: String(now),
      interval: '300000000000', price_window: '240000000000', close_before: '150000000000' });
    for (const holder of [rounds, market, verifier, owner.accountId]) {
      await ownerCall(token, 'storage_deposit', { account_id: holder, registration_only: true }, nearToYocto('0.1'));
    }
    const agentKey = KeyPair.fromRandom('ed25519'), agentId = `agent.${DEFAULT_ACCOUNT_ID}`;
    await owner.createAccount({ newAccountId: agentId, publicKey: agentKey.getPublicKey(),
      nearToTransfer: nearToYocto('5') });
    const deployment = { id: 'agent-chain', startBlock: '0', collateralTokenId: collateral,
      collateralDecimals: 6, contracts: { rounds, market, verifier } };
    const fake = agentApi(new Account(agentId, provider, agentKey.toString()),
      dragonsPolicy(deployment, owner.accountId));
    api = fake.server.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const port = (api.address() as { port: number }).port;
    const rpc = new ReadRpcClient(sandbox.rpcUrl, { timeoutMs: 10000, intervalMs: 50 });
    const client = new AgentApiClient({ url: `http://127.0.0.1:${port}`, key: KEY, timeoutMs: 60000 });
    const runner: AgentRunner = {
      deployment, api: client, transaction: (hash, sender) => finalTransaction(rpc, hash, sender),
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

    await ownerCall(rounds, 'storage_deposit', { account_id: agentId }, nearToYocto('0.05'));
    assert.equal(await view(rounds, 'is_registered', { account_id: agentId }), true);
    await ownerCall(token, 'mint', { account_id: owner.accountId, amount: (20n * USD).toString() });
    await owner.signAndSendTransaction({ receiverId: token, waitUntil: 'FINAL',
      actions: [actions.functionCall('ft_transfer_call', { receiver_id: rounds, amount: (9n * USD).toString(),
        msg: `deposit_for:${agentId}` }, teraToGas('300'), 1n)] });
    assert.equal(await balance(), (9n * USD).toString(), 'the owner funds the rounds balance straight from the wallet');
    assert.equal(await view(token, 'ft_balance_of', { account_id: agentId }), '0', 'the agent never holds the token');

    const [open] = await view(rounds, 'open_rounds', { from_index: 0, limit: 12 }) as { round: string }[];
    assert.equal(open!.round, '0', 'the round taking stakes is the one a client is told about');
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

    const outcome = () => view(rounds, 'round_outcome', { series_id: 0, round: '0' });
    assert.equal(await outcome(), null, 'a round still taking stakes has no outcome');
    const tooSoon = await run('claim-0', { kind: 'claim', series: 0, round: '0' });
    assert.equal(tooSoon.state, 'failed', 'and it cannot be claimed yet');
    const rpcUrl = sandbox.rpcUrl;
    const skipTo = async (target: bigint) => {
      while (BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec) < target) {
        await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'dontcare', method: 'sandbox_fast_forward',
            params: { delta_height: 600 } }) });
      }
    };
    await skipTo(now + 150_000_000_000n);
    assert.equal(await outcome(), 'refund', 'a one-sided round refunds, and the page can offer the claim');
    assert.equal((await view(rounds, 'get_round', { series_id: 0, round: '0' }) as { outcome: unknown }).outcome, null,
      'nothing has settled it: a client that waited for this field would wait forever');
    const claimed = await run('claim-1', { kind: 'claim', series: 0, round: '0' });
    assert.equal(claimed.state, 'confirmed', JSON.stringify(claimed.evidence));
    assert.equal(await balance(), (9n * USD).toString());

    const out = await run('out-1', { kind: 'withdraw', venue: 'rounds', amount: (9n * USD).toString() });
    assert.equal(out.state, 'confirmed', JSON.stringify(out.evidence));
    const intents = () => view(verifier, 'mt_balance_of', { account_id: agentId, token_id: collateral });
    assert.equal(await intents(), (9n * USD).toString(), 'the withdrawal lands in the agent account in NEAR Intents');

    const left = await run('leave-1', { kind: 'leave', venue: 'rounds' });
    assert.equal(left.state, 'confirmed', JSON.stringify(left.evidence));
    assert.equal(await view(rounds, 'is_registered', { account_id: agentId }), false);

    const inMarket = async () => BigInt(await view(market, 'get_balance', { account_id: agentId }) as string);
    const held = async (id: string) => (await view(market, 'get_shares', { market_id: id, account_id: agentId }) as string[]).map(BigInt);
    const secondsFromNow = async (seconds: bigint) => BigInt((await provider.viewBlock({ finality: 'final' })).header
      .timestamp_nanosec) + seconds * 1_000_000_000n;
    const closeAt = await secondsFromNow(300n), resolveBy = closeAt + 36_000n * 1_000_000_000n;
    await ownerCall(market, 'create_market', { title: 'Will the test question resolve Yes?',
      rule_text: 'Resolves Yes if the test says so.', resolution_source: 'https://example.com/source',
      void_policy: 'Void if the test is cancelled.', category: 'world', subcategory: 'science',
      close_at: String(closeAt), resolve_by: String(resolveBy) }, nearToYocto('0.06'));
    const created = await view(market, 'get_market', { market_id: '0' }) as { registered: boolean; status: string };
    assert.deepEqual([created.registered, created.status], [true, 'open'], 'the oracle registered it');

    const tooEarly = await run('buy-0', { kind: 'buy', market: '0', side: 'yes', amount: USD.toString(), minShares: '1' });
    assert.equal(tooEarly.state, 'failed', 'an agent that is not registered with the market cannot trade it');
    await ownerCall(market, 'storage_deposit', { account_id: agentId }, nearToYocto('0.05'));
    const paid = await owner.signAndSendTransaction({ receiverId: token, waitUntil: 'FINAL',
      actions: [actions.functionCall('ft_transfer_call', { receiver_id: market, amount: (6n * USD).toString(),
        msg: `deposit_for:${agentId}` }, teraToGas('300'), 1n)] });
    assert.ok(paid, 'the owner funds the market balance straight from the wallet');
    assert.equal(await inMarket(), 6n * USD);
    assert.equal(await view(token, 'ft_balance_of', { account_id: agentId }), '0', 'the agent never holds the token');

    const quote = await view(market, 'quote_buy', { market_id: '0', side: 'yes', amount: (4n * USD).toString() }) as
      { shares_out: string };
    const buy = (key: string, minShares: string) =>
      run(key, { kind: 'buy', market: '0', side: 'yes', amount: (4n * USD).toString(), minShares });
    const dear = await buy('buy-1', (BigInt(quote.shares_out) + 1n).toString());
    assert.equal(dear.state, 'failed', 'a buy past its minimum reverts, and the final transaction shows no trade');
    assert.equal(await inMarket(), 6n * USD, 'and the balance stays where it was');
    const bought = await buy('buy-2', quote.shares_out);
    assert.equal(bought.state, 'confirmed', JSON.stringify(bought.evidence));
    const [yes, no] = await held('0');
    assert.deepEqual([yes, no], [BigInt(quote.shares_out), 0n]);
    assert.equal(await inMarket(), 2n * USD, 'the buy was paid from the market balance');
    const sent = fake.sends();
    assert.equal((await buy('buy-2', quote.shares_out)).state, 'confirmed');
    assert.equal(fake.sends(), sent, 'a rerun of a confirmed buy sends nothing');

    const half = (yes! / 2n).toString();
    const sale = await view(market, 'quote_sell', { market_id: '0', side: 'yes', shares: half }) as
      { collateral_out: string; fee: string };
    const net = BigInt(sale.collateral_out) - BigInt(sale.fee);
    const sold = await run('sell-1', { kind: 'sell', market: '0', side: 'yes', shares: half,
      minCollateral: net.toString() });
    assert.equal(sold.state, 'confirmed', JSON.stringify(sold.evidence));
    assert.equal(await inMarket(), 2n * USD + net, 'a sale pays the market balance after its fee');

    const stuck = await run('leave-2', { kind: 'leave', venue: 'market' });
    assert.equal(stuck.state, 'failed', 'an agent still holding shares and money cannot leave');
    const unanswered = await run('redeem-0', { kind: 'redeem', market: '0' });
    assert.equal(unanswered.state, 'failed', 'a market with no answer redeems nothing');

    const bond = 5n * USD;
    await owner.signAndSendTransaction({ receiverId: token, waitUntil: 'FINAL',
      actions: [actions.functionCall('ft_transfer_call', { receiver_id: verifier, amount: bond.toString(),
        msg: owner.accountId }, teraToGas('300'), 1n)] });
    await skipTo(closeAt);
    await owner.signAndSendTransaction({ receiverId: verifier, waitUntil: 'FINAL',
      actions: [actions.functionCall('mt_transfer_call', { receiver_id: oracleId, token_id: collateral,
        amount: bond.toString(), msg: `propose:${market}:0:yes:https://example.com/evidence` }, teraToGas('300'), 1n)] });
    await skipTo(await secondsFromNow(3610n));
    await ownerCall(oracleId, 'finalize', { market, market_id: '0' });
    const answered = await view(market, 'get_market', { market_id: '0' }) as { outcome: string; status: string };
    assert.deepEqual([answered.outcome, answered.status], ['yes', 'resolved'], 'the oracle answered the market');
    const before = await inMarket();
    const redeemed = await run('redeem-1', { kind: 'redeem', market: '0' });
    assert.equal(redeemed.state, 'confirmed', JSON.stringify(redeemed.evidence));
    assert.ok(await inMarket() > before, 'a winning position pays into the market balance');
    assert.deepEqual(await held('0'), [0n, 0n]);

    const all = await inMarket(), intentsBefore = BigInt(await intents() as string);
    const paidOut = await run('out-2', { kind: 'withdraw', venue: 'market', amount: all.toString() });
    assert.equal(paidOut.state, 'confirmed', JSON.stringify(paidOut.evidence));
    assert.equal(BigInt(await intents() as string), intentsBefore + all, 'the market pays into NEAR Intents too');
    const gone = await run('leave-3', { kind: 'leave', venue: 'market' });
    assert.equal(gone.state, 'confirmed', JSON.stringify(gone.evidence));
    assert.equal(await view(market, 'is_registered', { account_id: agentId }), false);
  } finally {
    api?.close();
    if (sandbox) await stopSandbox(sandbox);
  }
});
