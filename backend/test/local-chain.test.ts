import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createReadApi } from '../src/read-api.js';
import { verifyDatabase } from '../src/database.js';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { migrate } from '../src/migrate.js';
import { readConfig } from '../src/config.js';
import { ingest } from '../src/ingestion/engine.js';
import { registerDeployment, ingestionStatus } from '../src/ingestion/store.js';
import { LocalSandboxReader, captureLocalTransactions, type TransactionReference } from '../src/ingestion/local-source.js';
import type { BlockSource } from '../src/ingestion/source.js';

// Separate from routine unit tests: starts an actual node and needs a local PostgreSQL URL.
test('unchanged rounds WASM -> actual finalized success/failure receipts -> Postgres -> restart/replay', { timeout: 180000 }, async t => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, 'Set TEST_DATABASE_URL to a local development PostgreSQL database');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname), 'Local integration requires a loopback PostgreSQL endpoint');
  const wasm = await readFile('.local/wasm/rounds.wasm').catch(() => { throw new Error('Build the existing rounds WASM first: npm run build:local-contract'); });
  const schema = `chain_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const connect = () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  let pool: pg.Pool | undefined;
  let sandbox: Sandbox | undefined;
  let schemaCreated = false;
  const previousTmp = process.env.TMPDIR;
  const previousBin = process.env.DIR_TO_DOWNLOAD_BINARY;
  // SDK download uses rename: keep temporary downloads and binary cache on one filesystem.
  await mkdir('.local/tmp', { recursive: true });
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const owner = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const roundsKey = KeyPair.fromRandom('ed25519');
    const outsiderKey = KeyPair.fromRandom('ed25519');
    const contractId = `rounds.${DEFAULT_ACCOUNT_ID}`;
    const outsiderId = `outsider.${DEFAULT_ACCOUNT_ID}`;
    await owner.createAccount({ newAccountId: contractId, publicKey: roundsKey.getPublicKey(), nearToTransfer: nearToYocto('40') });
    await owner.createAccount({ newAccountId: outsiderId, publicKey: outsiderKey.getPublicKey(), nearToTransfer: nearToYocto('10') });
    const rounds = new Account(contractId, provider, roundsKey.toString());
    const outsider = new Account(outsiderId, provider, outsiderKey.toString());
    await rounds.deployContract(wasm);
    await rounds.signAndSendTransaction({ receiverId: contractId, actions: [actions.functionCall('new', { owner_id: owner.accountId, operator_id: owner.accountId, verifier_id: owner.accountId, collateral_token_id: `nep141:usdc.${DEFAULT_ACCOUNT_ID}`, network: 'sandbox', price_threshold: 1 }, teraToGas('100'))], waitUntil: 'FINAL' });
    const reader = new LocalSandboxReader(sandbox.rpcUrl);
    const anchor = await reader.header({ finality: 'final' });
    const transactions: TransactionReference[] = [];
    const call = async (signer: Account, method: string, args: object, succeeds: boolean) => {
      const result = await signer.signAndSendTransaction({ receiverId: contractId, actions: [actions.functionCall(method, args, teraToGas('100'))], waitUntil: 'FINAL', throwOnFailure: false });
      assert.equal(typeof result.status === 'object' && result.status !== null && 'Failure' in result.status, !succeeds);
      transactions.push({ hash: result.transaction.hash, sender: signer.accountId });
    };
    await call(owner, 'set_fee_bps', { fee_bps: 450 }, true);
    await call(outsider, 'set_fee_bps', { fee_bps: 600 }, false);
    await call(owner, 'set_paused', { paused: true }, true);
    await call(owner, 'set_fee_bps', { fee_bps: 999999 }, false);
    await call(owner, 'set_fee_bps', { fee_bps: 700 }, true);
    const capture = await captureLocalTransactions(reader, anchor.hash, transactions);
    const targeted = capture.receipts.filter(r => r.receiver_id === contractId);
    const failed = targeted.filter(r => 'Failure' in r.status);
    assert.equal(failed.length, 2, 'Capture must retain both actual rejected executions');
    const expected = targeted.filter(r => !('Failure' in r.status)).flatMap(r => r.logs.filter(l => l.startsWith('EVENT_JSON:')).map(l => ({ receipt: r.receipt_id, event: JSON.parse(l.slice(11)) })));
    assert.deepEqual(expected.map(e => e.event.event).sort(), ['fee_set', 'fee_set', 'paused_set']);

    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    pool = connect();
    await migrate(pool);
    const config = readConfig({ DATABASE_URL: databaseUrl, NETWORK: 'sandbox', DEPLOYMENT_ID: 'local-receipt-integration', DEPLOYMENT_START_BLOCK: capture.startBlock, ROUNDS_CONTRACT_ID: contractId, VERIFIER_CONTRACT_ID: owner.accountId, COLLATERAL_TOKEN_ID: `nep141:usdc.${DEFAULT_ACCOUNT_ID}`, RPC_URL: sandbox.rpcUrl });
    await registerDeployment(pool, config);
    const frames: unknown[] = [];
    for await (const frame of capture.source.blocks()) frames.push(frame);
    const half = Math.max(1, Math.floor(frames.length / 2));
    const firstHalf: BlockSource = { id: capture.source.id, mode: 'local_capture', network: 'sandbox', async *blocks() { yield* frames.slice(0, half); } };
    assert.equal((await ingest(pool, config, firstHalf)).committed, half);
    await pool.end();
    pool = connect();
    const resumed = await ingest(pool, config, capture.source);
    assert.equal(resumed.replayed, half);
    assert.equal(resumed.committed, frames.length - half);
    assert.equal((await ingest(pool, config, capture.source)).committed, 0);
    const { rows } = await pool.query('SELECT receipt_id, event, payload, raw_log FROM raw_events ORDER BY block_height, receipt_id, log_index, data_index');
    assert.equal(rows.length, expected.length);
    assert.deepEqual(rows.map(r => `${r.receipt_id}:${r.event}`).sort(), expected.map(r => `${r.receipt}:${r.event.event}`).sort());
    for (const row of rows) assert.deepEqual(row.payload, JSON.parse(row.raw_log.slice(11)).data);
    assert.equal(rows.some(row => failed.some(r => r.receipt_id === row.receipt_id)), false);
    const state = await provider.callFunction({ contractId, method: 'config', args: {} }) as { fee_bps: number; paused: boolean };
    assert.equal(state.fee_bps, 700);
    assert.equal(state.paused, true);
    assert.deepEqual(rows.filter(r => r.event === 'fee_set').map(r => r.payload.fee_bps).sort((a, b) => a - b), [450, 700]);
    const status = await ingestionStatus(pool, config);
    assert.equal(status.checkpoint?.height, capture.endBlock);
    assert.equal(status.source?.mode, 'local_capture');
    assert.equal(status.live, false);
    assert.equal(Number(status.blocksCommitted), capture.blocks);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM indexed_blocks')).rows[0].n, capture.blocks);
    const app = createApp(config, () => verifyDatabase(pool!, config), () => ingestionStatus(pool!, config), createReadApi(pool, config));
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    try {
      const address = app.address();
      assert.ok(address && typeof address !== 'string');
      const root = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${root}/v1/events?limit=100`);
      assert.equal(response.status, 200);
      const evidence = await response.json();
      assert.equal(evidence.data.length, expected.length);
      assert.equal(evidence.asOf.height, capture.endBlock);
      assert.equal(evidence.indexing.source.mode, 'local_capture');
      assert.equal(evidence.indexing.live, false);
      assert.deepEqual(evidence.data.map((e: any) => `${e.receipt_id}:${e.event}`).sort(), expected.map(e => `${e.receipt}:${e.event.event}`).sort());
      for (const receipt of failed) {
        const rejected = await fetch(`${root}/v1/receipts/${receipt.receipt_id}`);
        assert.equal(rejected.status, 200);
        assert.deepEqual((await rejected.json()).data.outcome, receipt.status);
      }
    } finally {
      app.closeAllConnections();
      await new Promise<void>((resolve, reject) => app.close(e => e ? reject(e) : resolve()));
    }
    t.diagnostic(JSON.stringify({ sandboxVersion: '2.13.4', wasmSha256: createHash('sha256').update(wasm).digest('hex'), transactions: transactions.length, rejectedReceipts: failed.length, storedEvents: rows.length, blocks: capture.blocks, restartReplay: 'passed', readApi: 'passed', live: false }));
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        try { await pool?.end(); if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await admin.end(); }
      })(),
      sandbox?.tearDown() ?? Promise.resolve(),
    ]);
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    if (previousBin === undefined) delete process.env.DIR_TO_DOWNLOAD_BINARY; else process.env.DIR_TO_DOWNLOAD_BINARY = previousBin;
    const failedCleanup = cleanup.find(result => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') throw failedCleanup.reason;
  }
});
