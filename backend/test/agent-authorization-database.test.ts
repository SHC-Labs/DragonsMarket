import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { grantCommitment } from '@near-intents-agent-api/sdk';
import { agentAuthorizer, AgentAuthorizationRefused } from '../src/agent-authorization.js';
import type { AccountPolicy } from '../src/agent-api.js';
import { dragonsPolicy } from '../src/agent-policy.js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { operationStore, spentToday } from '../src/operations.js';

const grant = { agentId: 'a'.repeat(64), token: `ngt_${'g'.repeat(43)}` };
const agent = 'agent.near', owner = 'owner.near';
const buy = { kind: 'buy', market: '0', side: 'yes', amount: '5', minShares: '1' } as const;

async function database(run: (pool: pg.Pool, config: ReturnType<typeof readConfig>) => Promise<void>) {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Set TEST_DATABASE_URL explicitly; tests use an isolated schema');
  const schema = `agent_authorization_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({ DATABASE_URL: url, DEPLOYMENT_ID: 'authorization-test', DEPLOYMENT_START_BLOCK: '0',
    MARKET_CONTRACT_ID: 'market.test.near', VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near' });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    await run(pool, config);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function authority(pool: pg.Pool, deployment: string) {
  const accountId = randomUUID(), tokenId = randomUUID();
  await pool.query(`INSERT INTO agent_accounts(id,deployment_id,owner_account_id,name,agent_id,near_account_id,state)
    VALUES($1,$2,$3,'Agent',$4,$5,'active')`, [accountId, deployment, owner, grant.agentId, agent]);
  await pool.query(`INSERT INTO agent_grants(id,agent_account,commitment,sealed_token,label,api_grant_id,state,expires_at)
    VALUES($1,$2,$3,$4,'Grant','provider-grant','live',now()+interval '1 day')`,
  [randomUUID(), accountId, grantCommitment(grant.token), Buffer.from('test-only')]);
  await pool.query(`INSERT INTO agent_access_tokens(id,agent_account,token_hash,label,max_spend,daily_limit,
    message,nonce,expires_at) VALUES($1,$2,$3,'Bot',5,10,'signed terms','nonce',now()+interval '1 day')`,
  [tokenId, accountId, 'c'.repeat(64)]);
  return { accountId, tokenId };
}

const refusal = (code: string) => (error: unknown) =>
  error instanceof AgentAuthorizationRefused && error.message === code;

test('dispatch requires an applied, synchronized and unchanged account policy', () => database(async (pool, config) => {
  const deployment = config.deployment!, { tokenId } = await authority(pool, deployment.id);
  const valid: AccountPolicy = { status: 'APPLIED', revision: 1, synced: true, policy: dragonsPolicy(deployment, owner) };
  let policy = valid;
  const authorize = agentAuthorizer(pool, deployment, { policy: async () => policy });
  const job = { agent, action: buy, via: tokenId };
  await authorize(grant, job);
  for (const status of ['NONE', 'SIGNED', 'FAILED'] as const) {
    policy = { ...valid, status };
    await assert.rejects(authorize(grant, job), refusal('policy_not_ready'));
  }
  for (const patch of [{ synced: false }, { revision: null }, { revision: 0 }, { policy: null }]) {
    policy = { ...valid, ...patch };
    await assert.rejects(authorize(grant, job), refusal('policy_not_ready'));
  }
  for (const changed of [{ ...valid.policy, actions: ['withdraw', 'swap'] },
    { ...valid.policy, destinations: { mode: 'any', list: [] } }, { ...valid.policy, timelock_ms: 1000 }]) {
    policy = { ...valid, policy: changed };
    await assert.rejects(authorize(grant, job), refusal('provider_policy_mismatch'));
  }
  policy = { ...valid, policy: { ...valid.policy, frozen: true } };
  await assert.rejects(authorize(grant, job), refusal('wallet_frozen'));
  policy = valid;
  await authorize(grant, { ...job, via: `web:${owner}` });
  const outage = new Error('provider unavailable');
  const unavailable = agentAuthorizer(pool, deployment, { policy: async () => { throw outage; } });
  await assert.rejects(unavailable(grant, job), error => error === outage);
}));

test('dispatch binds the grant, connection, account and cash-out beneficiary', () => database(async (pool, config) => {
  const deployment = config.deployment!, { accountId, tokenId } = await authority(pool, deployment.id);
  let reads = 0;
  const authorize = agentAuthorizer(pool, deployment, { policy: async () => {
    reads++;
    return { status: 'APPLIED', revision: 1, synced: true, policy: dragonsPolicy(deployment, owner) };
  } });
  const job = { agent, action: buy, via: tokenId };
  await assert.rejects(authorize({ ...grant, token: `ngt_${'x'.repeat(43)}` }, job), refusal('agent_authorization_stale'));
  await assert.rejects(authorize(grant, { ...job, agent: 'other.near' }), refusal('agent_authorization_stale'));
  for (const via of [undefined, randomUUID(), 'web:other.near']) {
    await assert.rejects(authorize(grant, { agent, action: buy, ...(via ? { via } : {}) }),
      refusal('access_token_invalid'));
  }
  await assert.rejects(authorize(grant, { ...job, action: { ...buy, amount: '6' } }), refusal('spend_over_limit'));
  await assert.rejects(authorize(grant, { ...job, via: `web:${owner}`,
    action: { ...buy, amount: '100000001' } }), refusal('spend_over_limit'));
  await assert.rejects(authorize(grant, { ...job, action: { kind: 'leave', venue: 'market' } }),
    refusal('access_token_invalid'));
  await assert.rejects(authorize(grant, { ...job, action: { kind: 'cash_out', amount: '1', recipient: 'other.near' } }),
    refusal('policy_destination_denied'));
  assert.equal(reads, 0, 'locally denied requests never contact the provider');
  await authorize(grant, { ...job, action: { kind: 'cash_out', amount: '1', recipient: owner } });
  await pool.query('UPDATE agent_accounts SET frozen=true WHERE id=$1', [accountId]);
  await assert.rejects(authorize(grant, job), refusal('wallet_frozen'));
  await pool.query('UPDATE agent_accounts SET frozen=false WHERE id=$1', [accountId]);
  await pool.query('UPDATE agent_access_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
  await assert.rejects(authorize(grant, job), refusal('access_token_invalid'));
  await authorize(grant, { ...job, via: `web:${owner}` });
  await pool.query("UPDATE agent_grants SET state='revoked',sealed_token=NULL WHERE agent_account=$1", [accountId]);
  await assert.rejects(authorize(grant, { ...job, via: `web:${owner}` }), refusal('agent_authorization_stale'));
}));

test('unsigned and expired connections, expired grants and inactive accounts cannot dispatch', () =>
  database(async (pool, config) => {
    const deployment = config.deployment!, { accountId, tokenId } = await authority(pool, deployment.id);
    const authorize = agentAuthorizer(pool, deployment, { policy: async () => {
      throw new Error('a local refusal must not reach the provider');
    } });
    const job = { agent, action: buy, via: tokenId };
    await pool.query("UPDATE agent_access_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1", [tokenId]);
    await assert.rejects(authorize(grant, job), refusal('access_token_invalid'));
    await pool.query("UPDATE agent_access_tokens SET expires_at=now()+interval '1 day',token_hash=NULL WHERE id=$1", [tokenId]);
    await assert.rejects(authorize(grant, job), refusal('access_token_invalid'));
    await pool.query("UPDATE agent_grants SET expires_at=now()-interval '1 minute' WHERE agent_account=$1", [accountId]);
    await assert.rejects(authorize(grant, { ...job, via: `web:${owner}` }), refusal('agent_authorization_stale'));
    await pool.query("UPDATE agent_grants SET expires_at=now()+interval '1 day' WHERE agent_account=$1", [accountId]);
    await pool.query("UPDATE agent_accounts SET state='abandoned' WHERE id=$1", [accountId]);
    await assert.rejects(authorize(grant, { ...job, via: `web:${owner}` }), refusal('agent_authorization_stale'));
  }));

test('a connection revoked while the policy request is in flight cannot dispatch', () => database(async (pool, config) => {
  const deployment = config.deployment!, { tokenId } = await authority(pool, deployment.id);
  const authorize = agentAuthorizer(pool, deployment, { policy: async () => {
    await pool.query('UPDATE agent_access_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
    return { status: 'APPLIED', revision: 1, synced: true, policy: dragonsPolicy(deployment, owner) };
  } });
  await assert.rejects(authorize(grant, { agent, action: buy, via: tokenId }), refusal('access_token_invalid'));
}));

test('EVM principals cannot dispatch through existing MCP grants or an in-flight policy read', () =>
  database(async (pool, config) => {
    const deployment = config.deployment!, { accountId, tokenId } = await authority(pool, deployment.id);
    const evm = `eip155:8453:0x${'ab'.repeat(20)}`, job = { agent, action: buy, via: tokenId };
    let reads = 0;
    const authorize = agentAuthorizer(pool, deployment, { policy: async () => {
      reads++;
      await pool.query('UPDATE agent_accounts SET owner_account_id=$2 WHERE id=$1', [accountId, evm]);
      return { status: 'APPLIED', revision: 1, synced: true, policy: dragonsPolicy(deployment, owner) };
    } });
    await assert.rejects(authorize(grant, job), refusal('agent_owner_wallet_not_supported'));
    assert.equal(reads, 1, 'the final local recheck rejects a changed owner');
    for (const via of [tokenId, `web:${evm}`]) {
      await assert.rejects(authorize(grant, { ...job, via }), refusal('agent_owner_wallet_not_supported'));
    }
    assert.equal(reads, 1, 'an EVM owner is refused before requesting a NEAR payout policy');
  }));

test('unresolved spending stays reserved beyond 24 hours and confirmation starts its rolling window', () =>
  database(async (pool, config) => {
    const deployment = config.deployment!.id, store = operationStore(pool, deployment), via = randomUUID();
    const request = { via, action: buy }, cap = { via, amount: 5n, limit: 10n };
    const held = await store.prepare(agent, 'trade', 'old-buy', request, cap);
    await pool.query(`UPDATE user_operations SET created_at=now()-interval '3 days',
      updated_at=now()-interval '3 days' WHERE id=$1`,
      [held.id]);
    for (const state of ['prepared', 'submitted', 'unknown', 'reconcile']) {
      await pool.query('UPDATE user_operations SET state=$2 WHERE id=$1', [held.id, state]);
      assert.equal(await spentToday(pool, deployment, via), 5n, state);
      await assert.rejects(store.prepare(agent, 'trade', `over-${state}`,
        { via, action: { ...buy, amount: '6' } }, { ...cap, amount: 6n }), /daily_limit_reached/);
    }
    await store.transition({ id: held.id, agent }, 'reconcile', 'confirmed', { txHash: null, evidence: { proven: true } });
    assert.equal(await spentToday(pool, deployment, via), 5n, 'late confirmation still consumes the allowance');
    const [first, second] = await Promise.allSettled([
      store.prepare(agent, 'trade', 'concurrent-a', request, cap),
      store.prepare(agent, 'trade', 'concurrent-b', request, cap),
    ]);
    assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await spentToday(pool, deployment, via), 10n);
    await pool.query("UPDATE user_operations SET updated_at=now()-interval '25 hours' WHERE id=$1", [held.id]);
    assert.equal(await spentToday(pool, deployment, via), 5n, 'only the confirmed spend ages out');
    await pool.query("UPDATE user_operations SET state='failed' WHERE state='prepared'");
    assert.equal(await spentToday(pool, deployment, via), 0n, 'proved failures release reservations');
  }));
