import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import type pg from 'pg';
import { decodeKey, login, messageHash } from '../src/auth.js';
import { readConfig } from '../src/config.js';

// The example in NEP-413 (https://github.com/near/NEPs/blob/master/neps/nep-0413.md): message "hi", nonce [0..31],
// recipient "myapp.com", callbackUrl "myapp.com/callback". The NEP publishes the input and the hash recipe, not a signature.
// The keys below are the RFC 8032 test 1 key pair, and the signatures were produced by near-api-js signNep413Message,
// an implementation independent of src/auth.ts. Ed25519 is deterministic, so the same input always gives the same bytes.
const MESSAGE = 'hi';
const RECIPIENT = 'myapp.com';
const CALLBACK_URL = 'myapp.com/callback';
const NONCE = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PUBLIC_KEY = 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z';
const PUBLIC_KEY_HEX = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SIGNATURE_WITH_CALLBACK =
  '0h/YyX4yyoZfaWvmKHO0hP3h5itY3xrhTPu811Bgg8kVYHNXZAYnIsO6sTNNcZcLfclafU2Uc/0HmcoW4YguAg==';
const SIGNATURE_WITHOUT_CALLBACK =
  'ZxTX9utDnj3jN8vdhyt1UWPjj8eFPupDxUx4j+ZpblOcVcQAaP9G0o7ELvNMz9YwMP6w6vSKVXG91wXa+k2oCA==';
const NEP413_TAG = 2 ** 31 + 413;

const borshString = (s: string) => {
  const bytes = Buffer.from(s);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};
// Written out field by field from the spec, not shared with the code under test.
const expectedHash = (callbackUrl?: string) => {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const option = callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash('sha256')
    .update(Buffer.concat([tag, borshString(MESSAGE), NONCE, borshString(RECIPIENT), option]))
    .digest();
};
const publicKey = () => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeKey(PUBLIC_KEY)]), format: 'der', type: 'spki' });
const nonce64 = NONCE.toString('base64');

test('the prefix tag is 2^31 + 413 as four little-endian bytes', () => {
  assert.equal(NEP413_TAG, 2147484061);
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  assert.equal(tag.toString('hex'), '9d010080');
});

test('the NEP-413 example hashes the way the spec describes, with the callback URL present and absent', () => {
  assert.deepEqual(messageHash(MESSAGE, nonce64, RECIPIENT, CALLBACK_URL), expectedHash(CALLBACK_URL));
  assert.deepEqual(messageHash(MESSAGE, nonce64, RECIPIENT), expectedHash());
  assert.notDeepEqual(expectedHash(CALLBACK_URL), expectedHash());
});

test('an empty callback URL is treated as absent, a non-empty one changes the hash', () => {
  assert.deepEqual(messageHash(MESSAGE, nonce64, RECIPIENT, ''), expectedHash());
  assert.notDeepEqual(messageHash(MESSAGE, nonce64, RECIPIENT, 'myapp.com/other'), expectedHash(CALLBACK_URL));
});

test('the pinned ed25519 signatures verify over the hash, and only over their own form', () => {
  const key = publicKey();
  assert.equal(decodeKey(PUBLIC_KEY).toString('hex'), PUBLIC_KEY_HEX);
  const withCallback = Buffer.from(SIGNATURE_WITH_CALLBACK, 'base64');
  const withoutCallback = Buffer.from(SIGNATURE_WITHOUT_CALLBACK, 'base64');
  assert.equal(withCallback.length, 64);
  assert.ok(verify(null, messageHash(MESSAGE, nonce64, RECIPIENT, CALLBACK_URL), key, withCallback));
  assert.ok(verify(null, messageHash(MESSAGE, nonce64, RECIPIENT), key, withoutCallback));
  assert.ok(!verify(null, messageHash(MESSAGE, nonce64, RECIPIENT), key, withCallback));
  assert.ok(!verify(null, messageHash(MESSAGE, nonce64, RECIPIENT, CALLBACK_URL), key, withoutCallback));
});

test('any changed field breaks the signature', () => {
  const key = publicKey();
  const signature = Buffer.from(SIGNATURE_WITH_CALLBACK, 'base64');
  const changedNonce = Buffer.from(NONCE);
  changedNonce[0] = 1;
  for (const hash of [
    messageHash('ho', nonce64, RECIPIENT, CALLBACK_URL),
    messageHash(MESSAGE, changedNonce.toString('base64'), RECIPIENT, CALLBACK_URL),
    messageHash(MESSAGE, nonce64, 'myapp.org', CALLBACK_URL),
    messageHash(MESSAGE, nonce64, RECIPIENT, 'myapp.com/callbacl'),
  ])
    assert.ok(!verify(null, hash, key, signature));
});

test('the nonce must be exactly 32 bytes', () => {
  for (const length of [0, 31, 33]) assert.throws(() => messageHash(MESSAGE, Buffer.alloc(length).toString('base64'), RECIPIENT), /invalid_nonce/);
});

test('public keys: only ed25519 with a 32 byte key decode', () => {
  assert.equal(decodeKey(PUBLIC_KEY).length, 32);
  for (const bad of [
    'secp256k1:' + PUBLIC_KEY.slice(8),
    PUBLIC_KEY.slice(8),
    'ed25519:' + PUBLIC_KEY.slice(8, 20),
    'ed25519:0OIl' + PUBLIC_KEY.slice(12),
    PUBLIC_KEY + 'x'.repeat(10),
  ])
    assert.throws(() => decodeKey(bad), /invalid_public_key/);
});

// A wallet returns { accountId, publicKey: "ed25519:<base58>", signature: <string> } (SignedMessage in @hot-labs/near-connect).
// The service takes the signature as standard base64 of the 64 raw bytes. Other encodings fail before the database is read.
test('signature encodings other than padded base64 are refused before any lookup', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const config = readConfig({ DATABASE_URL: 'postgresql://localhost/unused' });
  const raw = Buffer.from(SIGNATURE_WITH_CALLBACK, 'base64');
  const untouched = {} as pg.Pool;
  const attempts = [
    raw.toString('hex'),
    raw.toString('base64url'),
    raw.toString('base64').replace(/=+$/, ''),
    'ed25519:' + SIGNATURE_WITH_CALLBACK,
    '',
  ];
  for (const signature of attempts)
    await assert.rejects(login(untouched, config, id, PUBLIC_KEY, signature, 'browser', async () => true), /invalid_login/);
});
