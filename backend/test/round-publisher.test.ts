import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { base58Decode, base58Encode } from '../src/base58.js';
import { loadPublisherKey, loadPublisherKeys, policyFrom, recorderFrom, roundPriceMessage, signableRounds, type Series } from '../src/round-publisher.js';
import type { Config } from '../src/config.js';

const SECOND = 10n ** 9n;
const series = (over: Partial<Series> = {}): Series => ({
  asset: 'btc-usd',
  decimals: 8,
  first_start: String(1000n * SECOND),
  interval: String(300n * SECOND),
  price_window: String(600n * SECOND),
  close_before: String(30n * SECOND),
  ...over,
});

function secretFor() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`, pub: Buffer.from(pub) };
}

test('base58 round-trips, including leading zero bytes', () => {
  for (const bytes of [Buffer.from([0, 0, 1, 2, 3]), Buffer.from([255, 254]), Buffer.alloc(32, 7)]) assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  assert.throws(() => base58Decode('0OIl'), /invalid_base58/);
});

test('a publisher key signs messages the public key verifies, and a mismatched key is refused', () => {
  const { secret, pub } = secretFor();
  const key = loadPublisherKey(secret);
  assert.equal(key.publicKey, `ed25519:${base58Encode(pub)}`);
  const message = roundPriceMessage('rounds.near', 'mainnet', 'btc-usd', '1700000100000000000', '8000000000000', 8);
  assert.equal(message, 'round-price:v1:rounds.near:mainnet:btc-usd:1700000100000000000:8000000000000:8');
  const signature = Buffer.from(key.sign(message), 'hex');
  assert.equal(signature.length, 64);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
  assert.equal(verify(null, Buffer.from(message), createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature), true);
  assert.equal(verify(null, Buffer.from(message + '0'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature), false);
  const other = secretFor();
  const raw = base58Decode(secret.slice(8));
  raw.set(other.pub, 32);
  assert.throws(() => loadPublisherKey(`ed25519:${base58Encode(raw)}`), /public half does not match/);
  assert.throws(() => loadPublisherKey('ed25519:' + base58Encode(Buffer.alloc(31, 1))), /ed25519 secret key/);
});

test('only rounds whose moment has settled and whose window has room left can be signed', () => {
  const s = series();
  const at = (r: bigint) => 1000n * SECOND + r * 300n * SECOND;
  assert.deepEqual(signableRounds(s, 999n * SECOND), [], 'before the first round');
  assert.deepEqual(signableRounds(s, at(0n) + 10n * SECOND), [], 'the exchanges have not closed the candle yet');
  assert.deepEqual(signableRounds(s, at(0n) + 20n * SECOND), [0n]);
  assert.deepEqual(signableRounds(s, at(1n) + 25n * SECOND), [0n, 1n], 'the previous round still has window left');
  assert.deepEqual(signableRounds(series({ interval: String(3000n * SECOND) }), at(0n) + 571n * SECOND), [], 'too close to the end of the window');
  assert.deepEqual(signableRounds(s, at(0n) + 571n * SECOND), [1n], 'round 0 is nearly out of window, round 1 is not');
  assert.deepEqual(signableRounds(s, at(5n) + 700n * SECOND), [6n, 7n], 'rounds whose window has closed are left alone');
});

test('one process signs with every listed publisher key, and refuses a repeated or ambiguous key source', async () => {
  const [a, b, c] = [secretFor(), secretFor(), secretFor()];
  const keys = await loadPublisherKeys({ PUBLISHER_KEY: `${a.secret}, ${b.secret},${c.secret}` });
  assert.deepEqual(keys.map(k => k.publicKey), [a, b, c].map(k => `ed25519:${base58Encode(k.pub)}`));
  await assert.rejects(loadPublisherKeys({ PUBLISHER_KEY: `${a.secret},${a.secret}` }), /listed twice/);
  await assert.rejects(loadPublisherKeys({ PUBLISHER_KEY: a.secret, PUBLISHER_KEY_FILE: '/tmp/key' }), /not both/);
  await assert.rejects(loadPublisherKeys({}), /set PUBLISHER_KEY or PUBLISHER_KEY_FILE/);
});

test('each asset can carry its own spread, falling back to the shared one', () => {
  const base = { PUBLISH_ROUND_PRICES: 'approved', PRICE_MAX_DEVIATION_BPS: '50' };
  assert.deepEqual(policyFrom({ ...base, PRICE_MAX_DEVIATION_BPS_NEAR: '100' }),
    { minimumSources: 3, maxDeviationBps: 50, assetDeviationBps: { NEAR: 100 } });
  assert.throws(() => policyFrom({ ...base, PRICE_MAX_DEVIATION_BPS_ETH: '0.5' }), /whole number/);
  assert.throws(() => policyFrom({ PRICE_MAX_DEVIATION_BPS: '50' }), /must be "approved"/);
});

test('recording prices is off without its key and refuses an incomplete setup', () => {
  const config = { deployment: { contracts: { rounds: 'rounds.near' } } } as unknown as Config;
  assert.equal(recorderFrom({}, config), null);
  const full = { ROUND_PRICES_KEY: 'k', ROUND_PRICES_ACCOUNT: 'ops.near', ROUND_PRICES_RPC: 'https://rpc.example', PRICE_SIGNATURES_URL: 'http://server.internal:3500' };
  assert.equal(typeof recorderFrom(full, config), 'function');
  assert.throws(() => recorderFrom({ ...full, ROUND_PRICES_RPC: 'http://rpc.example' }, config), /https ROUND_PRICES_RPC/);
  assert.throws(() => recorderFrom({ ...full, ROUND_PRICES_ACCOUNT: '' }, config), /ROUND_PRICES_ACCOUNT/);
  assert.throws(() => recorderFrom(full, { deployment: { contracts: {} } } as unknown as Config), /rounds contract/);
});
