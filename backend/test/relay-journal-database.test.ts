import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { relayJournal, type RelayJournal } from '../src/relay-journal.js';
import { createRelay, RelayError, type RelayRpc } from '../src/relay.js';
import { readConfig } from '../src/config.js';
import { base58Encode } from '../src/base58.js';
import { RpcError } from '../src/providers.js';

const key = () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { ...pair, publicKey, text: 'ed25519:' + base58Encode(Buffer.concat([
    pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32), publicKey])) };
};
const view = (data: unknown, block_hash = 'block') => ({ result: [...Buffer.from(JSON.stringify(data))], block_hash });
const outcome = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => error instanceof RelayError ? error.code : String(error));
const body = () => {
  const user = key();
  const payload = JSON.stringify({ signer_id: user.publicKey.toString('hex'), verifying_contract: 'intents.near',
    deadline: new Date(Date.now() + 300000).toISOString(), nonce: randomBytes(32).toString('base64'), intents: [
      { intent: 'transfer', receiver_id: 'market.near', tokens: { 'nep141:usdc.near': '5000000' }, msg: 'buy:3:yes:1' },
      { intent: 'transfer', receiver_id: 'relay.near', tokens: { 'nep141:usdc.near': '1000' } },
    ] });
  return { signed: [{ standard: 'raw_ed25519', payload, public_key: 'ed25519:' + base58Encode(user.publicKey),
    signature: 'ed25519:' + base58Encode(sign(null, Buffer.from(payload), user.privateKey)) }] };
};

test('real PostgreSQL coordinates relay restarts, overlaps, connection loss and transaction identity', { timeout: 30000 }, async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'TEST_DATABASE_URL must identify the local disposable test database');
  const schema = `relay_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const connect = () => new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 3 });
  let pool = connect();
  const other = connect();
  const signed: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    signed.push(request.params.signed_tx_base64);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const block = base58Encode(randomBytes(32));
  const secret = key().text;
  let pause: Promise<void> | null = null;
  let simulated = () => {};
  let dbLost = false;
  const rpc: RelayRpc = {
    primary: { call: async (method, params) => {
      const p = params as Record<string, unknown>;
      if (p.method_name === 'simulate_intents') {
        simulated();
        if (pause) await pause;
        return view({});
      }
      if (p.request_type === 'view_access_key') return { nonce: 41, block_hash: block, permission: {
        FunctionCall: { receiver_id: 'intents.near', method_names: ['execute_intents'], allowance: '1000000000000000000000000' } } };
      if (method === 'block') return { header: { hash: block } };
      throw new RpcError(-32000, 'UNKNOWN_TRANSACTION');
    } },
    reads: { call: async () => view('100000000') }, second: null, requireSecond: false,
    sendUrl: `http://127.0.0.1:${address.port}`,
  };
  const config = readConfig({ DATABASE_URL: url, NETWORK: 'sandbox', DEPLOYMENT_ID: schema, DEPLOYMENT_START_BLOCK: '1',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.near', VERIFIER_CONTRACT_ID: 'intents.near', MARKET_CONTRACT_ID: 'market.near',
    RELAYER_ACCOUNT_ID: 'relay.near', RELAYER_KEY: secret, RELAY_MIN_FEE: '1000' });
  const makeRelay = (journal: RelayJournal) => createRelay(config, rpc,
    { quote: async () => ({ fee: 1000n, validUntil: Date.now() + 300000 }), accepted: async () => 1000n }, journal)!;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await t.test('restart retains exact bytes and advances the cursor for a different payload', async () => {
      const original = body();
      assert.equal(await outcome(makeRelay(relayJournal(pool)).submit(original, () => true)), 'transaction_dropped');
      await pool.end(); pool = connect();
      const restarted = makeRelay(relayJournal(pool));
      assert.equal(await outcome(restarted.submit(original, () => true)), 'transaction_dropped');
      assert.equal(signed[0], signed[1]);
      assert.equal(await outcome(restarted.submit(body(), () => true)), 'transaction_dropped');
      const nonce = (bytes: string) => { const raw = Buffer.from(bytes, 'base64'); return raw.readBigUInt64LE(4 + raw.readUInt32LE(0) + 33); };
      assert.deepEqual(signed.map(nonce), [42n, 42n, 43n]);
    });
    await t.test('a second instance cannot sign while the first holds the key lease', async () => {
      let release = () => {};
      pause = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { simulated = resolve; });
      const first = outcome(makeRelay(relayJournal(pool)).submit(body(), () => true));
      try {
        await entered;
        const count = signed.length;
        assert.match(await outcome(makeRelay(relayJournal(other)).submit(body(), () => true)), /lock unavailable/);
        assert.equal(signed.length, count);
      } finally { release(); pause = null; await first; }
    });
    await t.test('loss of the database lease prevents simulation from advancing to broadcast', async () => {
      const count = signed.length;
      const journal = relayJournal(pool);
      const fenced: RelayJournal = { read: journal.read, withKey: (scope, payloads, work) => journal.withKey(scope, payloads, async lease => {
        const pid = (await other.query<{ pid: number }>(`SELECT pid FROM pg_locks
          WHERE locktype='advisory' AND granted AND classid=704346950 AND objid=hashtext($1)::oid AND pid<>pg_backend_pid()`, [scope])).rows;
        assert.equal(pid.length, 1);
        simulated = () => {};
        const wrapped = { ...lease, save: async (...args: Parameters<typeof lease.save>) => {
          await lease.save(...args);
          await other.query('SELECT pg_terminate_backend($1)', [pid[0]!.pid]);
          await new Promise(resolve => setTimeout(resolve, 30));
          dbLost = true;
        } };
        return work(wrapped);
      }) };
      assert.match(await outcome(makeRelay(fenced).submit(body(), () => true)), /lock unavailable/);
      assert.equal(dbLost, true);
      assert.equal(signed.length, count);
    });
    await t.test('a signed payload cannot be replaced under the same journal identity', async () => {
      const row = (await pool.query<{ scope: string; payload_hash: string }>('SELECT scope,payload_hash FROM relay_submissions LIMIT 1')).rows[0]!;
      await relayJournal(pool).withKey(row.scope, [row.payload_hash], async lease => {
        const record = lease.records.get(row.payload_hash)!;
        await assert.rejects(lease.save(row.payload_hash, { ...record, hash: createHash('sha256').update('other').digest('hex') }), /identity changed/);
        assert.equal((await relayJournal(other).read(row.scope, [row.payload_hash])).get(row.payload_hash)!.hash, record.hash);
      });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end(); await other.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
