import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { createApp } from '../src/app.js';
import { createPrivateApi } from '../src/private-api.js';
import { challenge, login, session, tokenHash } from '../src/auth.js';

const ABSOLUTE_SECONDS = 7200;
const IDLE_SECONDS = 1800;

test('sessions end at the absolute limit or after the idle limit, and sign-out-everywhere revokes every device', async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `sessions_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url }),
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({
    DATABASE_URL: url,
    DEPLOYMENT_ID: 'sessions-test',
    DEPLOYMENT_START_BLOCK: '0',
    ROUNDS_CONTRACT_ID: 'rounds.test.near',
    VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near',
    SESSION_ABSOLUTE_SECONDS: String(ABSOLUTE_SECONDS),
    SESSION_IDLE_SECONDS: String(IDLE_SECONDS),
  });
  const signer = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  const signIn = async (account: string) => {
    const c = await challenge(pool, config, account);
    const s = await signer.signNep413Message(account, {
      message: c.request.message,
      nonce: Buffer.from(c.request.nonce, 'base64'),
      recipient: c.request.recipient,
      callbackUrl: c.request.callbackUrl,
    });
    return login(pool, config, c.request.id, s.publicKey.toString(), Buffer.from(s.signature).toString('base64'), c.browser, async () => true);
  };
  const app = createApp(config, async () => {}, undefined, undefined, createPrivateApi(pool, config, async () => true));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    assert.equal(await migrate(pool), 0, 'migrations are re-appliable');

    const token = await signIn('alice.near');
    const row = async (t: string) => (await pool.query('SELECT extract(epoch FROM expires_at-created_at)::int AS life, last_seen_at FROM wallet_sessions WHERE token_hash=$1', [tokenHash(t)])).rows[0];
    assert.equal((await row(token)).life, ABSOLUTE_SECONDS, 'the absolute limit comes from configuration');
    assert.equal((await session(pool, config, token)).account_id, 'alice.near');

    const touched = async (t: string) => (await pool.query('SELECT last_seen_at > now()-interval \'10 seconds\' AS fresh FROM wallet_sessions WHERE token_hash=$1', [tokenHash(t)])).rows[0].fresh;
    await pool.query("UPDATE wallet_sessions SET last_seen_at=now()-interval '60 seconds' WHERE token_hash=$1", [tokenHash(token)]);
    await session(pool, config, token);
    assert.equal(await touched(token), false, 'a recent use does not write the row again');
    await pool.query("UPDATE wallet_sessions SET last_seen_at=now()-interval '20 minutes' WHERE token_hash=$1", [tokenHash(token)]);
    assert.ok(await session(pool, config, token));
    assert.equal(await touched(token), true, 'use inside the idle limit moves the idle clock forward');

    await pool.query("UPDATE wallet_sessions SET last_seen_at=now()-make_interval(secs=>$2) WHERE token_hash=$1", [tokenHash(token), IDLE_SECONDS + 5]);
    assert.equal(await session(pool, config, token), null, 'an idle session is over');

    const busy = await signIn('alice.near');
    await pool.query("UPDATE wallet_sessions SET expires_at=now()-interval '1 second', last_seen_at=now() WHERE token_hash=$1", [tokenHash(busy)]);
    assert.equal(await session(pool, config, busy), null, 'constant use cannot extend past the absolute limit');

    const phone = await signIn('alice.near'),
      laptop = await signIn('alice.near'),
      bob = await signIn('bob.near');
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    const root = `http://127.0.0.1:${address.port}`;
    const post = (cookie: string | null, origin: string = config.webOrigin) =>
      fetch(root + '/v1/auth/logout-all', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: `dm_session=${cookie}` } : {}) },
        body: '{}',
      });
    assert.equal((await post(null)).status, 401);
    assert.equal((await post(phone, 'https://attacker.example')).status, 403);
    const wrong = await post('x'.repeat(43));
    assert.equal(wrong.status, 401);
    assert.ok(await session(pool, config, laptop), 'refused requests revoke nothing');

    const response = await post(phone);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: false });
    assert.match(response.headers.get('set-cookie') ?? '', /^dm_session=; Max-Age=0/);
    assert.equal(await session(pool, config, phone), null);
    assert.equal(await session(pool, config, laptop), null, 'the other device is signed out too');
    assert.equal((await pool.query("SELECT 1 FROM wallet_sessions WHERE account_id='alice.near'")).rowCount, 0, 'the rows are gone, not just the cookie');
    assert.equal((await session(pool, config, bob)).account_id, 'bob.near', 'other accounts keep their sessions');

    const again = await signIn('alice.near');
    const logoutOne = await fetch(root + '/v1/auth/logout', { method: 'POST', headers: { Origin: config.webOrigin, 'Content-Type': 'application/json', Cookie: `dm_session=${again}` }, body: '{}' });
    assert.equal(logoutOne.status, 200);
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>((resolve, reject) => app.close(e => (e ? reject(e) : resolve())));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
