import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { followOwnerIntent, submitOwnerIntent, type IntentRow } from '../src/agent-accounts.js';
import type { AccountPolicy, AgentStatus, OwnerIntent } from '../src/agent-api.js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { privateKeyToAccount } from 'viem/accounts';
import { canonical } from '../src/ingestion/block.js';
import { consentFixture, evmConsentFixture } from './owner-intent-fixture.js';
import { policyOwner, policyWallet } from './evm-policy-fixture.js';
import { evmConsent } from '../src/agent-evm-consent.js';

async function fixture(run: (pool: pg.Pool, account: string) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL explicitly; tests use an isolated schema');
  const schema = `agent_intents_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: url, DEPLOYMENT_ID: 'intents-test', DEPLOYMENT_START_BLOCK: '0',
    MARKET_CONTRACT_ID: 'market.test.near', VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near' });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    const account = randomUUID();
    await pool.query(`INSERT INTO agent_accounts(id,deployment_id,owner_account_id,name,agent_id,near_account_id,state)
      VALUES($1,'intents-test','alice.near','Agent',$2,'agent.near','active')`, [account, 'a'.repeat(64)]);
    await run(pool, account);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function intent(pool: pg.Pool, account: string, type: 'agent_freeze' | 'agent_unfreeze' = 'agent_freeze') {
  const row: IntentRow = { correlation_id: `intent_${randomUUID()}`, agent_account: account,
    agent_id: 'a'.repeat(64), type, agent_grant: null, commitment: null, intent: {} as OwnerIntent,
    recorded: 'PENDING_SIGNATURE' };
  await pool.query(`INSERT INTO agent_intents(correlation_id,agent_account,type,intent,status,expires_at)
    VALUES($1,$2,$3,'{}','PENDING_SIGNATURE',now()+interval '5 minutes')`, [row.correlation_id, account, type]);
  return row;
}

const result = (row: IntentRow, status: AgentStatus['status']): AgentStatus => ({
  correlation_id: row.correlation_id, type: row.type, status, failure_code: null, details: {},
});
const applied = (frozen: boolean): AccountPolicy => ({ status: 'APPLIED', revision: 2, synced: true,
  policy: { frozen } });
const services = (db: pg.Pool, status: () => Promise<AgentStatus>,
  policy = async () => applied(true)) => ({ db, api: { status, policy,
  wallet: async () => { throw new Error('freeze intents must not create or read a wallet'); } } });
const stored = (pool: pg.Pool, row: IntentRow) => pool.query(`SELECT i.status,a.frozen FROM agent_intents i
  JOIN agent_accounts a ON a.id=i.agent_account WHERE correlation_id=$1`, [row.correlation_id]).then(r => r.rows[0]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('stored EVM revocations reject changed proofs before dispatch and persist the verified outcome',
  () => fixture(async (pool, account) => {
    const grantId = randomUUID(), request = { type: 'grant_revoke', agent_id: 'a'.repeat(64), grant_id: 'provider-grant' };
    const consent = consentFixture(request, policyOwner);
    const generated: OwnerIntent = { correlation_id: `intent_${randomUUID()}`, type: 'grant_revoke',
      agent_id: request.agent_id, signer: policyOwner, status: 'PENDING_SIGNATURE',
      expires_at: new Date(Date.now() + 300000).toISOString(), preview: { summary: 'Revoke grant' },
      intent: { standard: 'eip712', payload: evmConsentFixture(consent.payload.message) } };
    const owner = { type: 'evm' as const, account: `eip155:8453:${policyOwner.address}`, signer: policyOwner };
    await pool.query('UPDATE agent_accounts SET owner_account_id=$2 WHERE id=$1', [account, owner.account]);
    await pool.query(`INSERT INTO agent_grants(id,agent_account,commitment,label,state,expires_at)
      VALUES($1,$2,$3,'Grant','revoked',now()+interval '1 day')`, [grantId, account, 'b'.repeat(64)]);
    await pool.query(`INSERT INTO agent_intents(correlation_id,agent_account,type,intent,status,expires_at,agent_grant)
      VALUES($1,$2,$3,$4,'PENDING_SIGNATURE',$5,$6)`,
    [generated.correlation_id, account, generated.type, generated, generated.expires_at, grantId]);
    let submissions = 0;
    const s = { db: pool, deployment: { id: 'intents-test' },
      signing: { network: 'mainnet', walletContract: 'wallets.example.near', messageRecipient: 'agents.example.com' },
      api: { wallet: async () => { throw new Error('revocation must not create a wallet'); },
        policy: async () => { throw new Error('revocation must not read policy'); },
        submitIntent: async () => {
        submissions++;
        return { correlation_id: generated.correlation_id, type: generated.type,
          status: 'SUCCESS', failure_code: null, details: {} };
      } } } satisfies Parameters<typeof submitOwnerIntent>[0];
    const typed = evmConsent(generated.intent.payload, 'agents.example.com')!;
    const signed = { standard: 'eip712', payload: typed, signature: await policyWallet.signTypedData(typed) };
    await assert.rejects(submitOwnerIntent(s, owner, generated.correlation_id, { ...signed,
      payload: { ...typed, message: { ...typed.message, purpose: 'Transfer' } } }), /invalid_signed_data/);
    const other = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
    await assert.rejects(submitOwnerIntent(s, owner, generated.correlation_id, { ...signed,
      signature: await other.signTypedData(typed) }), /invalid_signature/);
    await assert.rejects(submitOwnerIntent({ ...s, signing: { ...s.signing, network: 'testnet' } },
      owner, generated.correlation_id, signed), /invalid_signature/);
    assert.equal(submissions, 0);
    assert.equal((await submitOwnerIntent(s, owner, generated.correlation_id, signed)).status, 'SUCCESS');
    assert.equal(submissions, 1);
    const { rows: [saved] } = await pool.query(`SELECT i.status,a.frozen FROM agent_intents i
      JOIN agent_accounts a ON a.id=i.agent_account WHERE i.correlation_id=$1`, [generated.correlation_id]);
    assert.deepEqual(saved, { status: 'SUCCESS', frozen: false });
  }));

test('a delayed observation cannot replace a completed owner intent, even when it matches its stale snapshot',
  () => fixture(async (pool, account) => {
    const row = await intent(pool, account);
    let release!: (value: AgentStatus) => void;
    const delayed = followOwnerIntent(services(pool, () => new Promise(resolve => { release = resolve; })), row);
    await followOwnerIntent(services(pool, async () => result(row, 'SUCCESS')), row);
    release(result(row, 'PROCESSING'));
    await assert.rejects(delayed, /owner_intent_observation_stale/);
    await assert.rejects(followOwnerIntent(services(pool, async () => result(row, 'PENDING_SIGNATURE')), row),
      /owner_intent_observation_stale/);
    assert.deepEqual(await stored(pool, row), { status: 'SUCCESS', frozen: true });
  }));

test('a repeated success cannot reapply an old freeze after a newer unfreeze', () => fixture(async (pool, account) => {
  const frozen = await intent(pool, account), thawed = await intent(pool, account, 'agent_unfreeze');
  await followOwnerIntent(services(pool, async () => result(frozen, 'SUCCESS')), frozen);
  await followOwnerIntent(services(pool, async () => result(thawed, 'SUCCESS'), async () => applied(false)), thawed);
  await Promise.all(Array.from({ length: 4 }, () =>
    followOwnerIntent(services(pool, async () => result(frozen, 'SUCCESS')), frozen)));
  assert.deepEqual(await stored(pool, frozen), { status: 'SUCCESS', frozen: false });
}));

test('first observations of older intents use current policy instead of reversing a newer transition',
  () => fixture(async (pool, account) => {
    const oldThaw = await intent(pool, account, 'agent_unfreeze'), newerFreeze = await intent(pool, account);
    await followOwnerIntent(services(pool, async () => result(newerFreeze, 'SUCCESS')), newerFreeze);
    await followOwnerIntent(services(pool, async () => result(oldThaw, 'SUCCESS')), oldThaw);
    assert.deepEqual(await stored(pool, oldThaw), { status: 'SUCCESS', frozen: true });
    const failedFreeze = await intent(pool, account);
    await followOwnerIntent(services(pool, async () => result(failedFreeze, 'FAILED')), failedFreeze);
    assert.deepEqual(await stored(pool, failedFreeze), { status: 'FAILED', frozen: true });
    const oldFreeze = await intent(pool, account), newerThaw = await intent(pool, account, 'agent_unfreeze');
    const unfrozen = async () => applied(false);
    await followOwnerIntent(services(pool, async () => result(newerThaw, 'SUCCESS'), unfrozen), newerThaw);
    await followOwnerIntent(services(pool, async () => result(oldFreeze, 'SUCCESS'), unfrozen), oldFreeze);
    assert.deepEqual(await stored(pool, oldFreeze), { status: 'SUCCESS', frozen: false });
  }));

test('a delayed policy read cannot overwrite another intent observation; a fresh retry can finish',
  () => fixture(async (pool, account) => {
    for (const nowFrozen of [true, false]) {
      const delayed = await intent(pool, account, nowFrozen ? 'agent_unfreeze' : 'agent_freeze');
      const newer = await intent(pool, account, nowFrozen ? 'agent_freeze' : 'agent_unfreeze');
      const began = deferred<void>(), response = deferred<AccountPolicy>();
      const waiting = followOwnerIntent(services(pool, async () => result(delayed, 'SUCCESS'), () => {
        began.resolve();
        return response.promise;
      }), delayed);
      const rejected = assert.rejects(waiting, /owner_policy_observation_stale/);
      await began.promise;
      await followOwnerIntent(services(pool, async () => result(newer, 'SUCCESS'), async () => applied(nowFrozen)), newer);
      response.resolve(applied(!nowFrozen));
      await rejected;
      assert.deepEqual(await stored(pool, delayed), { status: 'PENDING_SIGNATURE', frozen: nowFrozen });
      await followOwnerIntent(services(pool, async () => result(delayed, 'SUCCESS'), async () => applied(nowFrozen)), delayed);
      assert.deepEqual(await stored(pool, delayed), { status: 'SUCCESS', frozen: nowFrozen });
    }
  }));

test('unconfirmed policy cannot complete a transition or release the execution hold',
  () => fixture(async (pool, account) => {
    for (const policy of [
      { ...applied(false), status: 'SIGNED' as const }, { ...applied(false), synced: false },
      { ...applied(false), revision: 0 }, { ...applied(false), policy: null },
      { ...applied(false), status: 'FAILED' as const },
    ]) {
      const row = await intent(pool, account, 'agent_unfreeze');
      await followOwnerIntent(services(pool, async () => result(row, 'PROCESSING'), async () => policy), row);
      const current = { ...row, recorded: 'PROCESSING' };
      assert.deepEqual(await stored(pool, row), { status: 'PROCESSING', frozen: true });
      await assert.rejects(followOwnerIntent(services(pool, async () => result(row, 'SUCCESS'),
        async () => policy), current), /policy_not_ready/);
      assert.deepEqual(await stored(pool, row), { status: 'PROCESSING', frozen: true });
      await followOwnerIntent(services(pool, async () => result(row, 'SUCCESS'), async () => applied(false)), current);
      assert.deepEqual(await stored(pool, row), { status: 'SUCCESS', frozen: false });
    }
  }));

test('a policy outage leaves the intent retryable and cannot clear an existing freeze',
  () => fixture(async (pool, account) => {
    await pool.query('UPDATE agent_accounts SET frozen=true WHERE id=$1', [account]);
    const row = await intent(pool, account, 'agent_unfreeze');
    await assert.rejects(followOwnerIntent(services(pool, async () => result(row, 'SUCCESS'),
      async () => { throw new Error('policy read unavailable'); }), row), /policy read unavailable/);
    assert.deepEqual(await stored(pool, row), { status: 'PENDING_SIGNATURE', frozen: true });
    await followOwnerIntent(services(pool, async () => result(row, 'SUCCESS'), async () => applied(false)), row);
    assert.deepEqual(await stored(pool, row), { status: 'SUCCESS', frozen: false });
  }));

test('a conflicting provider outcome never silently overwrites a final result or changes the account',
  () => fixture(async (pool, account) => {
    for (const final of ['FAILED', 'REFUNDED', 'SUCCESS'] as const) {
      const row = await intent(pool, account);
      await followOwnerIntent(services(pool, async () => result(row, final)), row);
      const before = await stored(pool, row), latest = { ...row, recorded: final };
      await assert.rejects(followOwnerIntent(services(pool, async () => result(row,
        final === 'SUCCESS' ? 'FAILED' : 'SUCCESS')), latest), /owner_intent_observation_stale/);
      assert.deepEqual(await stored(pool, row), before);
    }
  }));

test('after a competing progress update, a fresh observation can still complete the same intent',
  () => fixture(async (pool, account) => {
    const row = await intent(pool, account);
    await followOwnerIntent(services(pool, async () => result(row, 'PROCESSING')), row);
    await assert.rejects(followOwnerIntent(services(pool, async () => result(row, 'SUCCESS')), row),
      /owner_intent_observation_stale/);
    await followOwnerIntent(services(pool, async () => result(row, 'SUCCESS')), { ...row, recorded: 'PROCESSING' });
    assert.deepEqual(await stored(pool, row), { status: 'SUCCESS', frozen: true });
  }));

test('grant finality binds EVM consent, preserves legacy NEAR observation and cannot revive revocation',
  () => fixture(async (pool, account) => {
    const wallet = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
    const owner = { type: 'evm' as const, address: wallet.address.toLowerCase(), chain_id: 8453,
      public_key: `0x${wallet.publicKey.slice(4)}` };
    for (const [legacy, altered] of [[false, false], [false, true], [true, false]]) {
      const id = randomUUID(), commitment = (legacy ? 'e' : altered ? 'b' : 'c').repeat(64);
      const signer = legacy ? { type: 'near' as const, account_id: 'alice.near', public_key: 'ed25519:key' } : owner;
      await pool.query('UPDATE agent_accounts SET owner_account_id=$2 WHERE id=$1',
        [account, legacy ? 'alice.near' : `eip155:${owner.chain_id}:${owner.address}`]);
      const request = { type: 'grant_issue', agent_id: 'a'.repeat(64), label: 'Dragons Market',
        credential: commitment, expires_at: new Date(Date.now() + 86400000).toISOString() };
      const near = consentFixture(request, signer), text = near.payload.message;
      const generated: OwnerIntent = { correlation_id: `intent_${id}`, type: 'grant_issue',
        agent_id: request.agent_id, signer, status: 'PENDING_SIGNATURE',
        expires_at: new Date(Date.now() + 290000).toISOString(), preview: { summary: 'Authorize' },
        intent: legacy ? near : { standard: 'eip712', payload: evmConsentFixture(text) } };
      if (legacy) delete (generated as Partial<OwnerIntent>).signer;
      await pool.query(`INSERT INTO agent_grants(id,agent_account,commitment,sealed_token,label,expires_at)
        VALUES($1,$2,$3,$4,'Dragons Market',$5)`, [id, account, commitment, Buffer.from('fixture'), request.expires_at]);
      await pool.query(`INSERT INTO agent_intents(correlation_id,agent_account,type,agent_grant,intent,status,expires_at)
        VALUES($1,$2,'grant_issue',$3,$4,'PENDING_SIGNATURE',$5)`,
      [generated.correlation_id, account, id, generated, generated.expires_at]);
      const row: IntentRow = { correlation_id: generated.correlation_id, agent_account: account,
        agent_id: request.agent_id, type: 'grant_issue', agent_grant: id, commitment, intent: generated,
        recorded: 'PENDING_SIGNATURE' };
      const message = JSON.parse(text);
      if (altered) message.owner.chain_id = 1;
      const grant = { grant_id: 'd'.repeat(64), agent_id: row.agent_id, revoked_at: null, owner_message: message };
      const api = services(pool, async () => ({ ...result(row, 'SUCCESS'), details: { grant } }));
      await followOwnerIntent(api, row);
      const state = () => pool.query('SELECT state FROM agent_grants WHERE id=$1', [id]).then(r => r.rows[0].state);
      assert.equal(await state(), altered ? 'failed' : 'live');
      if (!altered) {
        assert.equal(canonical(grant.owner_message), text);
        await pool.query("UPDATE agent_grants SET state='revoked',sealed_token=NULL WHERE id=$1", [id]);
        await followOwnerIntent(api, row);
        assert.equal(await state(), 'revoked');
      }
    }
  }));
