import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createApp } from '../src/app.js';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { ReadRpcClient, RpcError } from '../src/providers.js';
import { RelayError, createRelay, type Relay, type RelayRpc } from '../src/relay.js';
import type { FeeQuoter } from '../src/relay-fee.js';

const VERIFIER = 'intents.near', COLLATERAL = 'nep141:usdc.near', MARKET = 'market.near', ORACLE = 'oracle.near', RELAYER = 'relayer.near';
const NEAR = 10n ** 24n;

function evmKey() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12)).toString('hex');
  return (intents: object[], deadlineMs = 5 * 60_000) => {
    const payload = JSON.stringify({ signer_id: address, verifying_contract: VERIFIER, deadline: new Date(Date.now() + deadlineMs).toISOString(),
      nonce: randomBytes(32).toString('base64'), intents });
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(payload)}`), Buffer.from(payload)]));
    const recovered = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
    return { address, item: { standard: 'erc191', payload, signature: 'secp256k1:' + base58Encode(Buffer.concat([recovered.subarray(1), recovered.subarray(0, 1)])) } };
  };
}
const move = (to: string, amount: string, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [COLLATERAL]: amount }, ...extra });
const buyWithFee = () => [move(MARKET, '5000000', { msg: 'buy:3:yes:1' }), move(RELAYER, '1000')];
function relayKeyText() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return 'ed25519:' + base58Encode(Buffer.concat([privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32), publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
}
const fixedFee: FeeQuoter = { quote: async () => ({ fee: 1000n, validUntil: Date.now() }), accepted: async () => 1000n };
function relayWith(rpc: Partial<RelayRpc>, env: Record<string, string> = {}) {
  const refuse: RelayRpc['primary'] = { call: async () => { throw new RpcError('transport_or_timeout'); } };
  return createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'redteam', DEPLOYMENT_START_BLOCK: '1',
    COLLATERAL_TOKEN_ID: COLLATERAL, VERIFIER_CONTRACT_ID: VERIFIER, MARKET_CONTRACT_ID: MARKET, ORACLE_CONTRACT_ID: ORACLE,
    RELAYER_ACCOUNT_ID: RELAYER, RELAYER_KEY: relayKeyText(), RELAY_MIN_FEE: '1000', ...env }),
  { primary: refuse, second: null, reads: refuse, sendUrl: 'http://127.0.0.1:1', requireSecond: false, ...rpc }, fixedFee)!;
}
const viewResult = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: 'x' });
const codeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof RelayError ? error.code : String(error)));
const blockHash = base58Encode(randomBytes(32));
const txNonce = (signed: string) => {
  const bytes = Buffer.from(signed, 'base64');
  return bytes.readBigUInt64LE(4 + bytes.readUInt32LE(0) + 33);
};
const lowAllowanceLogs = (lines: string[]) => lines.filter(line => line.includes('relay_key_allowance_low')).length;

test('recovery releases only an expired unused signature proven at finalized blocks by both RPCs', async () => {
  const signed = evmKey()(buyWithFee(), -5 * 60_000);
  const body = { signed: [signed.item] };
  const payload = JSON.parse(signed.item.payload);
  const provider = (over: { used?: unknown; time?: string; hash?: string; queryHash?: string; bytes?: unknown } = {}): RelayRpc['primary'] => ({
    call: async (method, params) => {
      if (method === 'block') {
        assert.deepEqual(params, { finality: 'final' });
        return { header: { hash: over.hash ?? blockHash, timestamp_nanosec: over.time ?? String(BigInt(Date.now()) * 1000000n) } };
      }
      const p = params as Record<string, string>;
      assert.equal(p.block_id, over.hash ?? blockHash);
      assert.equal(p.account_id, VERIFIER);
      assert.equal(p.method_name, 'is_nonce_used');
      assert.deepEqual(JSON.parse(Buffer.from(p.args_base64!, 'base64').toString()), { account_id: signed.address, nonce: payload.nonce });
      return { ...viewResult(over.used ?? false), block_hash: over.queryHash ?? blockHash,
        ...(over.bytes === undefined ? {} : { result: over.bytes }) };
    },
  });
  const recover = (second: RelayRpc['second'], primary = provider()) =>
    relayWith({ primary, second, requireSecond: true }).recover!(body);
  assert.deepEqual(await recover(provider()), { unused: [true] });
  for (const second of [null, provider({ used: true }), provider({ used: 'false' }),
    provider({ time: String(BigInt(Date.parse(payload.deadline) + 119000) * 1000000n) }),
    provider({ hash: 'invalid-block' }), provider({ queryHash: base58Encode(randomBytes(32)) }),
    provider({ bytes: [256] }), provider({ bytes: [...Buffer.from('false trailing')] }),
  ]) assert.deepEqual(await recover(second), { unused: [false] });
  await assert.rejects(recover({ call: async () => { throw new RpcError('transport_or_timeout'); } }));
  const live = { signed: [evmKey()(buyWithFee()).item] };
  assert.deepEqual(await relayWith({ primary: provider(), second: provider(), requireSecond: true }).recover!(live), { unused: [false] });
});

/** The real paced ReadRpcClient (one call a second, the lowest RPC_INTERVAL_MS) in front of a fake balance view. */
function pacedBalances(balanceOf: (account: string) => string) {
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init!.body)) as { id: string; params: { args_base64: string } };
    const { account_id } = JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString()) as { account_id: string };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: viewResult(balanceOf(account_id)) }));
  }) as typeof fetch;
  return new ReadRpcClient('https://rpc.invalid', { timeoutMs: 10_000, intervalMs: 1000 }, null, transport);
}

async function stubRpc() {
  const sent: string[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const { method, params, id } = JSON.parse(text) as { method: string; params: Record<string, unknown>; id: string };
    if (method === 'send_tx') sent.push(String(params.signed_tx_base64));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, sent, close: () => { server.closeAllConnections(); server.close(); } };
}

/** A primary provider whose key reads come from `nonce()`, and whose transaction status is unknown, or pending when `pending` is set. */
function chain(nonce: () => number | bigint, { allowance = null, pending = false }: { allowance?: string | null; pending?: boolean } = {}): RelayRpc['primary'] {
  return { call: async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === 'query' && p.method_name === 'simulate_intents') return viewResult({});
    if (method === 'query' && p.request_type === 'view_access_key') {
      return { nonce: Number(nonce()), permission: { FunctionCall: { allowance, receiver_id: VERIFIER, method_names: ['execute_intents'] } }, block_height: 1, block_hash: blockHash };
    }
    if (method === 'block') return { header: { hash: blockHash } };
    if (method === 'EXPERIMENTAL_tx_status' && p.wait_until === 'NONE') {
      if (pending) return {};
      throw new RpcError(-32000, 'UNKNOWN_TRANSACTION');
    }
    throw new RpcError('transport_or_timeout');
  } };
}

async function app(relay: Relay) {
  const config = readConfig({ DATABASE_URL: 'postgresql://localhost/test', TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_ADDRESSES: '127.0.0.1', TRUSTED_PROXY_HEADER: 'x-real-ip' });
  const server = createApp(config, async () => {}, undefined, undefined, undefined, undefined, relay);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

const post = async (port: number, ip: string, body: object) => {
  const response = await fetch(`http://127.0.0.1:${port}/intents/relay`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip } });
  const json = await response.json() as { error?: { code: string } };
  return json.error?.code ?? 'ok';
};

// Each attacker address stays inside the per-client limits and signs with a fresh free key that holds nothing.
async function honestOutcomes(attackerNetworks: number, seconds: number) {
  const rpc = await stubRpc();
  const honestKeys = new Set<string>();
  const relay = relayWith({ reads: pacedBalances(account => (honestKeys.has(account) ? '100000000' : '0')), sendUrl: rpc.url, primary: chain(() => 1) });
  const server = await app(relay);
  const stop = Date.now() + seconds * 1000;
  const flood: Promise<unknown>[] = [];
  const fire = (n: number) => { if (Date.now() < stop) flood.push(post(server.port, `203.0.113.${n + 1}`, { signed: [evmKey()(buyWithFee()).item] })); };
  const timers: NodeJS.Timeout[] = [];
  for (let n = 0; n < attackerNetworks; n++) setTimeout(() => { fire(n); timers.push(setInterval(() => fire(n), 6000)); }, (n * 6000) / attackerNetworks);
  await new Promise(done => setTimeout(done, 3000));
  const honest: Promise<string>[] = [];
  for (let n = 0; Date.now() < stop; n++) {
    const user = evmKey()(buyWithFee());
    honestKeys.add(user.address);
    honest.push(post(server.port, `198.51.100.${n + 1}`, { signed: [user.item] }));
    await new Promise(done => setTimeout(done, 1500));
  }
  timers.forEach(clearInterval);
  const codes = await Promise.all(honest);
  await Promise.all(flood);
  await server.close();
  rpc.close();
  return codes;
}

test('baseline: with no attacker a funded honest user is never refused relay_busy', { timeout: 60_000 }, async () => {
  const codes = await honestOutcomes(0, 8);
  assert.equal(codes.filter(code => code === 'relay_busy').length, 0, `codes: ${codes}`);
});

test('12 client networks sending fresh unfunded keys cannot lock funded honest users out of the relay', { timeout: 60_000 }, async () => {
  const codes = await honestOutcomes(12, 24);
  const busy = codes.filter(code => code === 'relay_busy').length;
  assert.ok(busy / codes.length < 0.2, `${busy} of ${codes.length} honest requests got relay_busy while the attacker spent nothing: ${codes}`);
});

test('a client network found unfunded twice in a minute is refused before it takes a balance read, and others keep their own budget', async () => {
  let submits = 0;
  const relay: Relay = { submit: async () => { submits++; throw new RelayError(422, 'insufficient_balance'); }, quote: () => fixedFee.quote(),
    status: () => ({ keyAllowance: null, keyAllowanceLow: false }) };
  const server = await app(relay);
  const codes: string[] = [];
  for (let i = 0; i < 4; i++) codes.push(await post(server.port, '203.0.113.9', { signed: [] }));
  const other = await post(server.port, '203.0.113.10', { signed: [] });
  await server.close();
  assert.deepEqual(codes, ['insufficient_balance', 'insufficient_balance', 'rate_limited', 'rate_limited']);
  assert.equal(other, 'insufficient_balance');
  assert.equal(submits, 3);
});

test('a false nonce from one RPC is refused before reserving or signing a transaction', async () => {
  const rpc = await stubRpc();
  const lie = 10n ** 15n;
  let reads = 0;
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url,
    primary: chain(() => (reads++ === 0 ? lie : 41)), second: chain(() => 41) });
  try {
    assert.equal(await codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true)), 'rpc_disagreement');
    await codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true));
    assert.deepEqual(rpc.sent.map(txNonce), [42n]);
  } finally {
    rpc.close();
  }
});

test('a reserved nonce is not reused when an RPC later reports a lower value', async () => {
  const rpc = await stubRpc();
  const lie = 10n ** 15n;
  let reads = 0;
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary: chain(() => (reads++ === 0 ? lie : 41), { pending: true }) });
  try {
    await codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true));
    await codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true));
    assert.deepEqual(rpc.sent.map(txNonce), [lie + 1n, lie + 2n]);
  } finally {
    rpc.close();
  }
});

test('a send missing from the RPC is retried with identical signed bytes', async () => {
  const rpc = await stubRpc();
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary: chain(() => 41) });
  const body = { signed: [evmKey()(buyWithFee()).item] };
  try {
    const first = await codeOf(relay.submit(body, () => true));
    await codeOf(relay.submit(body, () => true));
    assert.equal(first, 'transaction_dropped');
    assert.deepEqual(rpc.sent.map(txNonce), [42n, 42n], 'the retry is sent again with the nonce the first send never used');
    assert.equal(rpc.sent[0], rpc.sent[1]);
  } finally {
    rpc.close();
  }
});

async function afterOneRequest(allowance: string, env: Record<string, string> = {}) {
  const rpc = await stubRpc();
  const relay = relayWith({ reads: { call: async () => viewResult('100000000000') }, sendUrl: rpc.url, primary: chain(() => 41, { allowance }) }, env);
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  try {
    await codeOf(relay.submit({ signed: [evmKey()(buyWithFee()).item] }, () => true));
  } finally {
    console.error = original;
    rpc.close();
  }
  return { relay, logged };
}

test('a relay key allowance under the alert threshold is logged once and shown in the status', async () => {
  const { relay, logged } = await afterOneRequest((NEAR / 2n).toString());
  assert.deepEqual(relay.status(), { keyAllowance: (NEAR / 2n).toString(), keyAllowanceLow: true });
  assert.equal(lowAllowanceLogs(logged), 1);
});

test('a healthy allowance is not flagged, and the threshold is configurable', async () => {
  const healthy = await afterOneRequest((5n * NEAR).toString());
  assert.equal(healthy.relay.status().keyAllowanceLow, false);
  assert.equal(lowAllowanceLogs(healthy.logged), 0);
  const strict = await afterOneRequest((5n * NEAR).toString(), { RELAY_KEY_ALLOWANCE_ALERT_NEAR: '10' });
  assert.equal(strict.relay.status().keyAllowanceLow, true);
});

test('readiness shows whether the relay key allowance is low', async () => {
  const { relay } = await afterOneRequest('1');
  const server = await app(relay);
  const ready = await fetch(`http://127.0.0.1:${server.port}/health/ready`).then(response => response.json()) as { relay?: unknown };
  await server.close();
  assert.deepEqual(ready.relay, { keyAllowanceLow: true });
});
