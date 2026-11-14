import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { evmChallenge, evmLogin, EVM_LOGIN_STATEMENT } from '../src/evm-auth.js';
import { challenge, login, session, tokenHash } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { migrate, migrationFiles } from '../src/migrate.js';
import { registerDeployment } from '../src/ingestion/store.js';
import { createApp } from '../src/app.js';
import { createPrivateApi } from '../src/private-api.js';

test('the wallet identity migration preserves existing NEAR challenges and sessions', async () => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `evm_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const token = 't'.repeat(43), id = randomUUID();
  const config = readConfig({ DATABASE_URL: url });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE schema_migrations
      (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of (await migrationFiles()).filter(f => f.name < '015_')) {
      await pool.query(file.sql);
      await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [file.name, file.checksum]);
    }
    await pool.query(`INSERT INTO wallet_sessions(token_hash,account_id,network,public_key,expires_at)
      VALUES($1,'alice.near',$2,'ed25519:existing',now()+interval '1 hour')`, [tokenHash(token), config.network]);
    await pool.query(`INSERT INTO wallet_challenges
      (id,account_id,network,origin,nonce,browser_hash,message,expires_at)
      VALUES($1,'alice.near',$2,$3,'oldnonce','oldbrowser','oldmessage',now()+interval '5 minutes')`,
    [id, config.network, config.webOrigin]);
    assert.equal(await migrate(pool), (await migrationFiles()).length - 14);
    const identity = await session(pool, config, token);
    assert.equal(identity.account_id, 'alice.near');
    assert.equal(identity.wallet_type, 'near');
    assert.equal(identity.evm_chain_id, null);
    const row = (await pool.query('SELECT wallet_type,evm_chain_id,message FROM wallet_challenges WHERE id=$1', [id])).rows[0];
    assert.deepEqual(row, { wallet_type: 'near', evm_chain_id: null, message: 'oldmessage' });
    assert.equal(await migrate(pool), 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('EVM sign-in proves a browser-bound, chain-scoped identity without transaction authority', async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  const schema = `evm_auth_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const config = readConfig({
    DATABASE_URL: url, WEB_ORIGIN: 'https://dragons.example',
    DEPLOYMENT_ID: 'evm-auth-test', DEPLOYMENT_START_BLOCK: '0',
    ROUNDS_CONTRACT_ID: 'rounds.test.near', VERIFIER_CONTRACT_ID: 'verifier.test.near',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.test.near',
  });
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const prepare = async (chainId = 1) => {
    const c = await evmChallenge(pool, config, alice.address, chainId);
    const signature = await alice.signMessage({ message: c.request.message });
    return { c, proof: { id: c.request.id, signature, browser: c.browser } };
  };
  const signIn = async (chainId = 1) => evmLogin(pool, config, (await prepare(chainId)).proof);
  let agentCalls = 0;
  const app = createApp(config, async () => {}, undefined, undefined,
    createPrivateApi(pool, config, async () => { throw new Error('EVM login must not call NEAR RPC'); }, null, {
      owner: async (_method, _path, owner) => { agentCalls++; return { owner }; }, access: async () => ({}),
    }));
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await registerDeployment(pool, config);
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    const root = `http://127.0.0.1:${address.port}`;

    await t.test('the exact SIWE message binds address, chain, origin, nonce, purpose and expiry', async () => {
      const { c, proof } = await prepare(8453);
      const message = parseSiweMessage(c.request.message);
      assert.equal(message.address, alice.address);
      assert.equal(message.chainId, 8453);
      assert.equal(message.domain, 'dragons.example');
      assert.equal(message.scheme, 'https');
      assert.equal(message.uri, config.webOrigin);
      assert.equal(message.statement, EVM_LOGIN_STATEMENT);
      assert.equal(message.requestId, c.request.id);
      assert.match(message.nonce!, /^[0-9a-f]{64}$/);
      assert.equal(message.expirationTime!.getTime() - message.issuedAt!.getTime(), 300000);
      const token = await evmLogin(pool, config, proof);
      const identity = await session(pool, config, token);
      assert.equal(identity.account_id, `eip155:8453:${alice.address.toLowerCase()}`);
      assert.equal(identity.wallet_type, 'evm');
      assert.equal(identity.evm_chain_id, '8453');
      assert.equal(identity.public_key, '0x' + alice.publicKey.slice(4).toLowerCase());
      await assert.rejects(evmLogin(pool, config, proof), /invalid_login/);
    });

    await t.test('a stolen challenge cannot be used by another browser or deployment origin', async () => {
      const { proof } = await prepare();
      await assert.rejects(evmLogin(pool, config, { ...proof, browser: 'x'.repeat(43) }), /invalid_login/);
      await assert.rejects(evmLogin(pool, { ...config, webOrigin: 'https://other.example' }, proof), /invalid_login/);
      await assert.rejects(evmLogin(pool, { ...config, network: 'mainnet' }, proof), /invalid_login/);
      assert.ok(await evmLogin(pool, config, proof), 'unrelated requests cannot consume the browser challenge');
    });

    await t.test('signature substitution, altered messages and malformed signatures are rejected', async () => {
      for (const change of ['signer', 'chain', 'origin', 'purpose', 'nonce', 'malformed']) {
        const { c, proof } = await prepare();
        let message = c.request.message;
        if (change === 'chain') message = message.replace('Chain ID: 1', 'Chain ID: 8453');
        if (change === 'origin') message = message.replaceAll('dragons.example', 'attacker.example');
        if (change === 'purpose') message = message.replace(EVM_LOGIN_STATEMENT, 'Transfer all funds.');
        if (change === 'nonce') message = message.replace(/Nonce: [a-f0-9]+/, 'Nonce: 12345678');
        const signature = change === 'malformed' ? '0xdeadbeef'
          : await (change === 'signer' ? bob : alice).signMessage({ message });
        await assert.rejects(evmLogin(pool, config, { ...proof, signature }), /invalid_login/, change);
        await assert.rejects(evmLogin(pool, config, proof), /invalid_login/, 'rejection consumes the challenge');
      }
    });

    await t.test('only one concurrent verification issues a session', async () => {
      const { proof } = await prepare();
      const before = (await pool.query('SELECT count(*)::int AS n FROM wallet_sessions')).rows[0].n;
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => evmLogin(pool, config, proof)));
      assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM wallet_sessions')).rows[0].n, before + 1);
    });

    await t.test('expired challenges and cross-standard proofs cannot issue sessions', async () => {
      const { proof } = await prepare();
      await pool.query("UPDATE wallet_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [proof.id]);
      await assert.rejects(evmLogin(pool, config, proof), /invalid_login/);
      const near = await challenge(pool, config, 'alice.near');
      const signature = await alice.signMessage({ message: near.request.message });
      await assert.rejects(evmLogin(pool, config, { id: near.request.id, browser: near.browser, signature }), /invalid_login/);
      const evm = await prepare();
      await assert.rejects(login(pool, config, evm.proof.id, 'bad', Buffer.alloc(64).toString('base64'),
        evm.proof.browser, async () => true), /invalid_login/);
    });

    await t.test('invalid addresses and chain identifiers never reach storage', async () => {
      for (const chainId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(evmChallenge(pool, config, alice.address, chainId), /invalid_evm_account/);
      }
      for (const address of ['alice.near', '0xabc', alice.address + '\n', '0x' + 'zz'.repeat(20)]) {
        await assert.rejects(evmChallenge(pool, config, address, 1), /invalid_evm_account/);
      }
      await assert.rejects(pool.query(`INSERT INTO wallet_sessions
        (token_hash,account_id,network,public_key,expires_at,wallet_type)
        VALUES('bad','alice.near',$1,'bad',now()+interval '1 hour','evm')`, [config.network]),
      (e: unknown) => (e as { code: string }).code === '23514');
    });

    await t.test('HTTP verification sets protected cookies and rejects duplicate browser cookies', async () => {
      const headers = { Origin: config.webOrigin, 'Content-Type': 'application/json' };
      const request = await fetch(root + '/v1/auth/evm/challenge', {
        method: 'POST', headers, body: JSON.stringify({ address: alice.address, chainId: 1 }),
      });
      assert.equal(request.status, 200);
      const c = await request.json();
      const cookieHeader = request.headers.get('set-cookie')!;
      assert.match(cookieHeader, /^__Host-dm_challenge=/);
      assert.match(cookieHeader, /HttpOnly; SameSite=Strict; Path=\/; Secure/);
      const cookie = cookieHeader.split(';')[0]!;
      const signature = await alice.signMessage({ message: c.message });
      const verify = (Cookie: string, Origin = config.webOrigin) => fetch(root + '/v1/auth/evm/verify', {
        method: 'POST', headers: { ...headers, Cookie, Origin }, body: JSON.stringify({ id: c.id, signature }),
      });
      assert.equal((await verify(cookie, 'https://attacker.example')).status, 403);
      assert.equal((await verify(`${cookie}; ${cookie}`)).status, 401);
      const verified = await verify(cookie);
      assert.equal(verified.status, 200);
      const cookies = verified.headers.getSetCookie();
      assert.match(cookies[0]!, /^__Host-dm_session=/);
      assert.match(cookies[1]!, /^__Host-dm_challenge=; Max-Age=0/);
      const result = await fetch(root + '/v1/auth/session', { headers: { Cookie: cookies[0]!.split(';')[0]! } });
      assert.equal((await result.json()).session.account_id, `eip155:1:${alice.address.toLowerCase()}`);
    });

    await t.test('an EVM login forwards its verified identity for inspection but cannot provision custody', async () => {
      const token = await signIn();
      const headers = { Cookie: `__Host-dm_session=${token}`, Origin: config.webOrigin };
      const read = await fetch(root + '/v1/agents', { headers });
      assert.equal(read.status, 200);
      assert.deepEqual((await read.json()).owner, { type: 'evm', account: `eip155:1:${alice.address.toLowerCase()}`,
        signer: { type: 'evm', address: alice.address.toLowerCase(), chain_id: 1,
          public_key: `0x${alice.publicKey.slice(4).toLowerCase()}` } });
      const create = await fetch(root + '/v1/agents', { method: 'POST', headers });
      assert.equal(create.status, 409);
      assert.equal((await create.json()).error.code, 'agent_owner_wallet_not_supported');
      assert.equal(agentCalls, 1);
    });

    await t.test('watchlists and logout stay scoped to the authenticated wallet and chain', async () => {
      const one = await signIn(1), two = await signIn(8453), otherDevice = await signIn(1);
      const headers = (token: string) => ({
        Cookie: `__Host-dm_session=${token}`, Origin: config.webOrigin, 'Content-Type': 'application/json',
      });
      const saved = await fetch(root + '/v1/watchlist', {
        method: 'PUT', headers: headers(one), body: JSON.stringify({ item: 'market.near/1' }),
      });
      assert.equal(saved.status, 200);
      const list = await fetch(root + '/v1/watchlist', { headers: headers(two) });
      assert.deepEqual((await list.json()).data, []);
      const logout = await fetch(root + '/v1/auth/logout-all', { method: 'POST', headers: headers(one), body: '{}' });
      assert.equal(logout.status, 200);
      assert.equal(await session(pool, config, one), null);
      assert.equal(await session(pool, config, otherDevice), null);
      assert.ok(await session(pool, config, two));
      await pool.query("UPDATE wallet_sessions SET last_seen_at=now()-interval '2 days' WHERE token_hash=$1", [tokenHash(two)]);
      assert.equal(await session(pool, config, two), null);
    });
  } finally {
    app.closeAllConnections();
    if (app.listening) await new Promise<void>(resolve => app.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
