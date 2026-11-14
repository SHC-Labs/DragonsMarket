import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createApp } from '../src/app.js';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { decimal } from '../src/prices.js';
import { RpcError } from '../src/providers.js';
import { RELAY_AUTH_GAS, RelayError, createRelay, executeIntentsKeyNonce, validateItem, validateRelay, type Relay, type RelayContext, type RelayRpc } from '../src/relay.js';
import { FeeAboveCeiling, GAS_PER_ACTION, MIN_GAS_PRICE, createFeeQuoter, medianPrice, nearUsdFrom, requiredFee, type FeeSettings } from '../src/relay-fee.js';

const context: RelayContext = { verifier: 'intents.near', collateral: 'nep141:usdc.near', market: 'market.near', oracle: 'oracle.near', relayer: 'relayer.near', minFee: 1000n, maxFee: 100_000n };
const NOW = Date.parse('2026-11-09T12:00:00Z');
const inFiveMinutes = new Date(NOW + 5 * 60_000).toISOString();

function evmKey() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(secret, false).subarray(1)).subarray(12)).toString('hex');
  const digest = (text: string) => keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(text)}`), Buffer.from(text)]));
  const signature = (text: string) => {
    const recovered = secp256k1.sign(digest(text), secret, { prehash: false, format: 'recovered' });
    return Buffer.concat([recovered.subarray(1), recovered.subarray(0, 1)]);
  };
  return { address, signature };
}
const evmSigner = evmKey(), otherEvmSigner = evmKey();
const EVM = evmSigner.address;

const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const SOLANA = publicKey.toString('hex');

const move = (to: string, amount: string, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [context.collateral]: amount }, ...extra });
const fee = (amount = '1000') => move(context.relayer, amount);
const buy = (msg = 'buy:3:yes:1', amount = '5000000') => move(context.market, amount, { msg });

function payload(intents: object[], overrides: Record<string, unknown> = {}, signer = EVM) {
  return JSON.stringify({ signer_id: signer, verifying_contract: context.verifier, deadline: inFiveMinutes,
    nonce: randomBytes(32).toString('base64'), intents, ...overrides });
}
const evm = (text: unknown, extra: object = {}, key = evmSigner) => ({ standard: 'erc191', payload: text,
  signature: 'secp256k1:' + base58Encode(typeof text === 'string' ? key.signature(text) : Buffer.concat([randomBytes(64), Buffer.from([1])])), ...extra });
const solana = (text: string, extra: object = {}) => ({ standard: 'raw_ed25519', payload: text, public_key: 'ed25519:' + base58Encode(publicKey),
  signature: 'ed25519:' + base58Encode(sign(null, Buffer.from(text), keyPair.privateKey)), ...extra });

const refusedWith = (code: string, run: () => unknown) =>
  assert.throws(run, (error: unknown) => error instanceof RelayError && error.status === 400 && error.code === code, code);

test('accepts the signed actions the web builds, for both signer kinds', () => {
  const accepted = [
    evm(payload([{ ...move(context.market, '5000000', { msg: 'register' }) }, fee()])),
    evm(payload([buy(), fee('2500')])),
    evm(payload([fee(), buy()])),
    solana(payload([buy('buy:12:no:900000'), fee()], {}, SOLANA)),
    evm(payload([move(context.oracle!, '5000000', { msg: 'propose:market.near:4:yes:https://example.com/a?b=c:d' }), fee()])),
    evm(payload([move(context.oracle!, '5000000', { msg: 'challenge:market.near:4:void' }), fee()])),
    evm(payload([buy('buy:3:yes:1', '5000000'), fee()], { deadline: new Date(NOW + 10 * 60_000).toISOString() })),
  ];
  for (const [index, item] of accepted.entries()) {
    const valid = validateItem(item, context, NOW, index);
    assert.equal(valid.signer, index === 3 ? SOLANA : EVM);
    assert.equal(valid.item.payload, (item as { payload: string }).payload, 'the signed string is forwarded byte for byte');
  }
});

test('accepts one or two items from one signer and nothing else', () => {
  const register = evm(payload([move(context.market, '5000000', { msg: 'register' }), fee()]));
  const trade = evm(payload([buy(), fee()]));
  assert.equal(validateRelay({ signed: [register] }, context, NOW).length, 1);
  assert.equal(validateRelay({ signed: [register, trade] }, context, NOW).length, 2);
  refusedWith('invalid_request', () => validateRelay({ signed: [] }, context, NOW));
  refusedWith('invalid_request', () => validateRelay({ signed: [register, trade, trade] }, context, NOW));
  refusedWith('invalid_request', () => validateRelay({ signed: register }, context, NOW));
  refusedWith('invalid_request', () => validateRelay({ signed: [register], extra: 1 }, context, NOW));
  refusedWith('mixed_signers', () => validateRelay({ signed: [register, evm(payload([buy(), fee()], {}, otherEvmSigner.address), {}, otherEvmSigner)] }, context, NOW));
});

test('refuses items that are not exactly a supported signed message', () => {
  const good = payload([buy(), fee()]);
  const cases: [string, unknown][] = [
    ['invalid_item', 'text'],
    ['invalid_item', evm(good, { extra: 1 })],
    ['invalid_item', evm(good, { public_key: 'ed25519:' + base58Encode(publicKey) })],
    ['unsupported_standard', evm(good, { standard: 'nep413' })],
    ['unsupported_standard', evm(good, { standard: 'webauthn' })],
    ['invalid_payload', evm(42)],
    ['invalid_payload', evm('{not json')],
    ['invalid_payload', evm('[]')],
    ['invalid_payload', evm(good.slice(0, -1) + ',"extra":1}')],
    ['invalid_payload', evm('x'.repeat(2049))],
    ['invalid_signature', evm(good, { signature: 'ed25519:' + base58Encode(randomBytes(65)) })],
    ['invalid_signature', evm(good, { signature: 'secp256k1:' + base58Encode(randomBytes(64)) })],
    ['invalid_signature', evm(good, { signature: 'secp256k1:' + base58Encode(Buffer.concat([randomBytes(64), Buffer.from([27])])) })],
    ['invalid_signature', evm(good, { signature: 'secp256k1:0OIl' })],
    ['invalid_signature', solana(payload([buy(), fee()], {}, SOLANA), { signature: 'ed25519:' + base58Encode(randomBytes(63)) })],
    ['invalid_public_key', solana(payload([buy(), fee()], {}, SOLANA), { public_key: 'ed25519:' + base58Encode(randomBytes(31)) })],
    ['invalid_public_key', solana(payload([buy(), fee()], {}, SOLANA), { public_key: undefined })],
    ['signer_key_mismatch', solana(payload([buy(), fee()], {}, 'ab'.repeat(32)))],
  ];
  for (const [index, [code, item]] of cases.entries()) refusedWith(code, () => validateItem(item, context, NOW, index));
});

test('refuses payloads for another verifier, a bad deadline, a bad nonce or a bad signer', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['wrong_verifier', { verifying_contract: 'other.near' }],
    ['invalid_deadline', { deadline: new Date(NOW - 1000).toISOString() }],
    ['invalid_deadline', { deadline: new Date(NOW).toISOString() }],
    ['invalid_deadline', { deadline: new Date(NOW + 10 * 60_000 + 1000).toISOString() }],
    ['invalid_deadline', { deadline: '2026-11-09T12:05:00+00:00' }],
    ['invalid_deadline', { deadline: NOW + 60_000 }],
    ['invalid_deadline', { deadline: 'soon' }],
    ['invalid_nonce', { nonce: randomBytes(31).toString('base64') }],
    ['invalid_nonce', { nonce: 'not base64!' }],
    ['invalid_nonce', { nonce: undefined }],
    ['invalid_signer', { signer_id: '0x' + 'AB'.repeat(20) }],
    ['invalid_signer', { signer_id: '0x' + 'ab'.repeat(19) }],
    ['invalid_signer', { signer_id: 'alice.near' }],
    ['invalid_signer', { signer_id: SOLANA }],
  ];
  for (const [index, [code, overrides]] of cases.entries()) {
    refusedWith(code, () => validateItem(evm(payload([buy(), fee()], overrides)), context, NOW, index));
  }
  refusedWith('invalid_signer', () => validateItem(solana(payload([buy(), fee()], {}, EVM)), context, NOW, 0));
});

test('refuses payloads whose intents are anything but one fee and one allowed action', () => {
  const run = (...intents: object[]) => () => validateItem(evm(payload(intents)), context, NOW, 0);
  refusedWith('invalid_intents', run());
  refusedWith('invalid_intents', run(fee()));
  refusedWith('invalid_intents', run(buy(), fee(), fee()));
  refusedWith('invalid_intents', run(buy(), buy('buy:4:no:1'), fee()));
  refusedWith('invalid_intent', run({ intent: 'token_diff', diff: {} }, fee()));
  refusedWith('action_not_allowed', run({ intent: 'auth_call', contract_id: context.market, msg: 'buy', min_gas: '1' }, fee()));
  refusedWith('invalid_fee', run(buy(), 'transfer' as unknown as object));
  refusedWith('invalid_intent', run(buy(), { ...fee(), memo: 'x' }));
  refusedWith('invalid_transfer', run(buy(), { ...fee(), tokens: { 'nep141:other.near': '1000' } }));
  refusedWith('invalid_transfer', run(buy(), { ...fee(), tokens: { [context.collateral]: '1000', 'nep141:other.near': '1' } }));
  refusedWith('invalid_transfer', run(buy(), { ...fee(), tokens: {} }));
  refusedWith('invalid_transfer', run(buy(), fee('0')));
  refusedWith('invalid_transfer', run(buy(), fee('-1000')));
  refusedWith('invalid_transfer', run(buy(), fee('1e4')));
  refusedWith('invalid_transfer', run(buy(), fee('1000.5')));
  refusedWith('invalid_transfer', run(buy(), { ...fee(), tokens: { [context.collateral]: 1000 } }));
  refusedWith('invalid_transfer', run(buy(), fee((2n ** 128n).toString())));
  refusedWith('invalid_transfer', run(buy('buy:3:yes:1', '0'), fee()));
  refusedWith('invalid_transfer', run({ ...buy(), receiver_id: 7 }, fee()));
  refusedWith('invalid_transfer', run({ ...buy(), msg: 7 }, fee()));
});

test('authenticated exits support both wallet signatures, with bounded arguments and no deposits or owner methods', () => {
  const auth = (msg: string, extra = {}) => ({ intent: 'auth_call', contract_id: context.market, msg, min_gas: RELAY_AUTH_GAS, ...extra });
  for (const msg of ['sell:3:yes:1000000:0', 'sell:3:no:1000000:500000', 'redeem:3', 'withdraw:1000000']) {
    for (const [id, signed] of [[EVM, evm], [SOLANA, solana]] as const) {
      const valid = validateItem(signed(payload([auth(msg), fee()], {}, id)), context, NOW, 0);
      assert.equal(valid.spend, 1000n);
      assert.equal(valid.to, context.market);
    }
  }
  for (const action of [auth('set_owner:attacker.near'), auth('withdraw:0'), auth('sell:3:yes:0:1'),
    auth(`redeem:${2n ** 64n}`), auth(`withdraw:${2n ** 128n}`), auth('sell:3:yes:1:-1'), auth('withdraw:1:extra'),
    auth('redeem:1', { contract_id: 'attacker.near' }), auth('redeem:1', { attached_deposit: '1' }),
    auth('redeem:1', { min_gas: '300000000000000' })]) {
    refusedWith('action_not_allowed', () => validateItem(evm(payload([action, fee()])), context, NOW, 0));
  }
});

test('an access-key nonce must be an exact nonnegative JSON integer', () => {
  const permission = { FunctionCall: { receiver_id: context.verifier, method_names: ['execute_intents'], allowance: '1000' } };
  for (const nonce of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '42']) {
    assert.equal(executeIntentsKeyNonce({ nonce, permission }, context.verifier), null);
  }
  assert.equal(executeIntentsKeyNonce({ nonce: 42, permission }, context.verifier), 42n);
});

test('refuses a fee that is missing, short, doubled, carries a message or goes elsewhere', () => {
  const run = (...intents: object[]) => () => validateItem(evm(payload(intents)), context, NOW, 0);
  refusedWith('invalid_fee', run(buy(), move('someone.near', '1000')));
  refusedWith('invalid_fee', run(buy(), fee('999')));
  refusedWith('invalid_fee', run(buy(), fee('100001')));
  refusedWith('invalid_fee', run(fee(), fee()));
  refusedWith('invalid_fee', run(buy(), { ...fee(), msg: 'x' }));
  refusedWith('invalid_intent', run(buy(), { ...fee(), msg: '', min_gas: '1' }));
  validateItem(evm(payload([buy(), fee('1000')])), context, NOW, 0);
  validateItem(evm(payload([buy(), fee('100000')])), context, NOW, 0);
});

test('refuses actions to anyone but the market and the oracle, and messages they do not take', () => {
  const run = (to: string, msg: string | undefined) => () =>
    validateItem(evm(payload([move(to, '5000000', msg === undefined ? {} : { msg }), fee()])), context, NOW, 0);
  refusedWith('action_not_allowed', run('someone.near', 'buy:3:yes:1'));
  refusedWith('action_not_allowed', run('attacker.near', 'register'));
  refusedWith('action_not_allowed', run(context.market, undefined));
  refusedWith('action_not_allowed', run(context.market, 'deposit'));
  refusedWith('action_not_allowed', run(context.market, ''));
  refusedWith('action_not_allowed', run(context.market, 'register:extra'));
  refusedWith('action_not_allowed', run(context.market, 'buy:3:maybe:1'));
  refusedWith('action_not_allowed', run(context.market, 'buy:x:yes:1'));
  refusedWith('action_not_allowed', run(context.market, 'buy:3:yes'));
  refusedWith('action_not_allowed', run(context.market, 'buy:3:yes:1:2'));
  refusedWith('action_not_allowed', run(context.market, 'buy:3:yes:-1'));
  refusedWith('action_not_allowed', run(context.market, 'buy:3:void:1'));
  refusedWith('action_not_allowed', run(context.oracle!, 'register'));
  refusedWith('action_not_allowed', run(context.oracle!, 'price:market.near:4:100'));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:other.near:4:yes:https://x'));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:market.near:4:maybe:https://x'));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:market.near:four:yes:https://x'));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:market.near:4:yes'));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:market.near:4:yes:' + 'x'.repeat(513)));
  refusedWith('action_not_allowed', run(context.oracle!, 'propose:market.near:4:yes:line\nbreak'));
  refusedWith('action_not_allowed', run(context.oracle!, 'challenge:other.near:4:no'));
  refusedWith('action_not_allowed', run(context.oracle!, 'challenge:market.near:4:no:extra'));
  refusedWith('action_not_allowed', run(context.oracle!, 'challenge:market.near:4'));
});

test('refuses an oracle action when no oracle is configured', () => {
  const noOracle = { ...context, oracle: null };
  refusedWith('action_not_allowed', () => validateItem(evm(payload([move('oracle.near', '5000000', { msg: 'challenge:market.near:4:no' }), fee()])), noOracle, NOW, 0));
});

test('min_gas is refused: the web never sets it, and a value the gas budget cannot cover fails after simulation, on our gas', () => {
  for (const min_gas of ['5000000000000', '250000000000000', 'abc', 50]) {
    refusedWith('invalid_intent', () => validateItem(evm(payload([{ ...buy(), min_gas }, fee()])), context, NOW, 0));
  }
});

test('a payload must be byte-for-byte what JSON.stringify gives for its own parse, so serde and JSON.parse cannot read it differently', () => {
  const good = payload([buy(), fee()]);
  const feeTokens = `"tokens":{"${context.collateral}":"1000"}`;
  assert.ok(good.includes(feeTokens));
  const variants = [
    good.replace(feeTokens, `"tokens":{"${context.collateral}":"1","${context.collateral}":"1000"}`),
    good.replace(`"receiver_id":"${context.relayer}"`, `"receiver_id":"attacker.near","receiver_id":"${context.relayer}"`),
    good.replace('"msg":"buy:3:yes:1"', '"msg":"deposit","msg":"buy:3:yes:1"'),
    good.replace('{"signer_id"', `{"signer_id":"${otherEvmSigner.address}","signer_id"`),
    good.replace('"intents":[', '"intents":[],"intents":['),
    good.replace('"intent":"transfer"', '"intent":"ft_withdraw","intent":"transfer"'),
    good.replace(`"${context.relayer}"`, `"relayer\\u002enear"`),
    good.replace('{', '{ '),
    good.replace(',', ',\n'),
    '\ufeff' + good,
    good + '\n',
  ];
  for (const [index, text] of variants.entries()) {
    assert.notEqual(text, good, `variant ${index} changes the payload`);
    refusedWith('invalid_payload', () => validateItem(evm(text), context, NOW, index));
  }
  validateItem(evm(good), context, NOW, 0);
});

test('a deadline must leave time to land: one that expires between simulation and execution burns our gas for nothing', () => {
  const at = (ms: number) => () => validateItem(evm(payload([buy(), fee()], { deadline: new Date(NOW + ms).toISOString() })), context, NOW, 0);
  refusedWith('invalid_deadline', at(1500));
  refusedWith('invalid_deadline', at(59_999));
  at(60_000)();
  refusedWith('invalid_deadline', () => validateItem(evm(payload([buy(), fee()], { deadline: '2026-11-09T12:05:00.000000001Z' })), context, NOW, 0));
  for (const deadline of ['2026-11-09T12:05:00Z', '2026-11-09T24:00:00.000Z', '2026-11-08T12:05:00.000Z'.replace('11-08', '02-31')]) {
    refusedWith('invalid_deadline', () => validateItem(evm(payload([buy(), fee()], { deadline })), context, NOW, 0));
  }
});

test('a versioned nonce is refused: its own expiry and salt can turn invalid after simulation', () => {
  const versioned = Buffer.concat([Buffer.from('5628f6c6', 'hex'), randomBytes(28)]).toString('base64');
  refusedWith('invalid_nonce', () => validateItem(evm(payload([buy(), fee()], { nonce: versioned })), context, NOW, 0));
});

test('signatures are checked locally, the way intents.near checks them, before anything reaches the queue', () => {
  const text = payload([buy(), fee()]);
  const other = payload([buy(), fee()]);
  const signature = evmSigner.signature(text);
  const n = secp256k1.Point.Fn.ORDER;
  const s = BigInt('0x' + signature.subarray(32, 64).toString('hex'));
  const highS = Buffer.concat([signature.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex'), Buffer.from([signature[64]! ^ 1])]);
  const encode = (bytes: Buffer) => 'secp256k1:' + base58Encode(bytes);
  const flipped = Buffer.from(signature); flipped[10]! ^= 1;
  const recovery = Buffer.from(signature); recovery[64]! ^= 1;
  const cases: [string, unknown][] = [
    ['someone else signed it', evm(text, { signature: encode(otherEvmSigner.signature(text)) })],
    ['signed a different payload', evm(text, { signature: encode(evmSigner.signature(other)) })],
    ['a flipped bit', evm(text, { signature: encode(flipped) })],
    ['the other recovery id', evm(text, { signature: encode(recovery) })],
    ['the malleable high-s twin', evm(text, { signature: encode(highS) })],
    ['ed25519 over another payload', solana(payload([buy(), fee()], {}, SOLANA), { signature: 'ed25519:' + base58Encode(sign(null, Buffer.from(other), keyPair.privateKey)) })],
    ['ed25519 by another key', solana(payload([buy(), fee()], {}, SOLANA), { signature: 'ed25519:' + base58Encode(sign(null, Buffer.from(text), generateKeyPairSync('ed25519').privateKey)) })],
  ];
  for (const [name, item] of cases) {
    assert.throws(() => validateItem(item, context, NOW, 0), (error: unknown) => error instanceof RelayError && error.code === 'invalid_signature', name);
  }
  validateItem(evm(text), context, NOW, 0);
});

test('the same signed item twice in one request is refused', () => {
  const item = evm(payload([move(context.market, '5000000', { msg: 'register' }), fee()]));
  refusedWith('duplicate_item', () => validateRelay({ signed: [item, item] }, context, NOW));
});

function strictParse(text: string): unknown {
  let at = 0;
  const fail = (): never => { throw new Error(`strict parse failed at ${at}`); };
  const space = () => { while (' \t\n\r'.includes(text[at] ?? 'x')) at++; };
  const string = (): string => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/.exec(text.slice(at)) ?? fail();
    at += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const value = (): unknown => {
    space();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space();
      const out: Record<string, unknown> = {};
      if (text[at] === '}') { at++; return out; }
      for (;;) {
        space();
        const key = string();
        if (Object.hasOwn(out, key)) fail();
        space(); if (text[at++] !== ':') fail();
        Object.defineProperty(out, key, { value: value(), enumerable: true, configurable: true, writable: true });
        space();
        if (text[at] === ',') { at++; continue; }
        if (text[at++] === '}') return out;
        fail();
      }
    }
    if (c === '[') {
      at++; space();
      const out: unknown[] = [];
      if (text[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value()); space();
        if (text[at] === ',') { at++; continue; }
        if (text[at++] === ']') return out;
        fail();
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at)) ?? fail();
    at += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const result = value();
  space();
  return at === text.length ? result : fail();
}

function mutations(seed: number) {
  let state = seed;
  const random = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const chars = ['"', '\\', 'u', '0', '1', '9', ':', ',', '{', '}', '[', ']', ' ', '\n', 'e', '-', '+', '.', 'A', '\ufeff', '\u2028', '\u0000'];
  const amounts = ['01000', '1000.0', '1e3', '-1000', '+1000', ' 1000', '\uff11000', '0x3e8', '1000 ', '999', '1_000', '340282366920938463463374607431768211456'];
  const receivers = ['attacker.near', 'relayer.near ', 'Relayer.near', 'market.near\u0000', context.relayer, context.market, context.oracle!];
  return (text: string): string => {
    switch (Math.floor(random() * 7)) {
      case 0: { const i = Math.floor(random() * (text.length + 1)); return text.slice(0, i) + pick(chars) + text.slice(i); }
      case 1: { const i = Math.floor(random() * text.length); return text.slice(0, i) + pick(chars) + text.slice(i + 1); }
      case 2: { const i = Math.floor(random() * text.length); return text.slice(0, i) + text.slice(i + 1); }
      case 3: {
        const pairs = [...text.matchAll(/"([a-z_]+|nep141:[^"]+)":("[^"]*"|\[|\{)/g)];
        const [whole, key] = pick(pairs);
        const fake = pick([...receivers, ...amounts, 'register', 'buy:4:no:1', 'ft_withdraw']);
        const i = text.indexOf(whole!, Math.floor(random() * text.length / 2));
        const at = i < 0 ? text.indexOf(whole!) : i;
        return random() < 0.5
          ? text.slice(0, at) + `"${key}":${JSON.stringify(fake)},` + text.slice(at)
          : text.slice(0, at + whole!.length) + (whole!.endsWith('"') ? `,"${key}":${JSON.stringify(fake)}` : '') + text.slice(at + whole!.length);
      }
      case 4: return text.replace(/"(\d+)"/, () => JSON.stringify(pick(amounts)));
      case 5: return text.replace(new RegExp(`"(${[context.relayer, context.market].join('|')})"`), () => JSON.stringify(pick(receivers)));
      default: {
        const strings = [...text.matchAll(/"[^"\\]+"/g)];
        const { 0: whole, index } = pick(strings);
        const j = 1 + Math.floor(random() * (whole.length - 2));
        const code = whole.charCodeAt(j).toString(16).padStart(4, '0');
        return text.slice(0, index! + j) + `\\u${code}` + text.slice(index! + j + 1);
      }
    }
  };
}

test('fuzz: a mutated payload passes only when there is a single reading of it and that reading is one we pay for', () => {
  const base = [
    payload([buy(), fee()], {}, SOLANA),
    payload([fee('2500'), move(context.market, '5000000', { msg: 'register' })], {}, SOLANA),
    payload([move(context.oracle!, '5000000', { msg: 'propose:market.near:4:yes:https://e.com/a:b' }), fee()], {}, SOLANA),
  ];
  let passed = 0, iterations = 0;
  for (const [seedIndex, original] of base.entries()) {
    const mutate = mutations(0x5eed + seedIndex);
    for (let round = 0; round < 1500; round++) {
      let text = original;
      for (let steps = 1 + (round % 3); steps > 0; steps--) text = mutate(text);
      if (text === original) continue;
      iterations++;
      let valid: ReturnType<typeof validateItem> | null = null;
      try { valid = validateItem(solana(text), context, NOW, 0); } catch (error) {
        assert.ok(error instanceof RelayError && error.status === 400, `only a clean refusal: ${String(error)}`);
      }
      if (!valid) continue;
      passed++;
      const strict = strictParse(text) as Record<string, unknown>;
      assert.deepEqual(strict, JSON.parse(text), `no duplicate key or second reading: ${text}`);
      assert.equal(JSON.stringify(strict), text, `canonical: ${text}`);
      const transfers = strict.intents as Record<string, unknown>[];
      for (const transfer of transfers) {
        assert.deepEqual(Object.keys(transfer.tokens as object), [context.collateral], text);
        assert.match(Object.values(transfer.tokens as object)[0] as string, /^[1-9]\d*$/, text);
        assert.ok([context.relayer, context.market, context.oracle].includes(transfer.receiver_id as string), text);
      }
      const fees = transfers.filter(transfer => transfer.receiver_id === context.relayer);
      assert.equal(fees.length, 1, text);
      assert.ok(BigInt((fees[0]!.tokens as Record<string, string>)[context.collateral]!) >= context.minFee, text);
      assert.equal(fees[0]!.msg, undefined, text);
    }
  }
  assert.ok(iterations > 4000, `ran ${iterations} mutations`);
  assert.ok(passed > 0, 'some semantic mutations (another valid amount or action) still pass, so the property is not vacuous');
});

test('the error carries the index of the item that failed', () => {
  const good = evm(payload([buy(), fee()]));
  const bad = evm(payload([buy(), fee('1')]));
  assert.throws(() => validateRelay({ signed: [good, bad] }, context, NOW), (error: unknown) => error instanceof RelayError && error.index === 1);
});

test('the relay settings are all-or-nothing and need a deployment', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'testnet', DEPLOYMENT_ID: 'd', DEPLOYMENT_START_BLOCK: '1',
    COLLATERAL_TOKEN_ID: 'nep141:usdc.testnet', VERIFIER_CONTRACT_ID: 'intents.testnet', MARKET_CONTRACT_ID: 'market.testnet' };
  const secret = 'ed25519:' + base58Encode(randomBytes(64));
  const relay = { RELAYER_ACCOUNT_ID: 'relayer.testnet', RELAYER_KEY: secret, RELAY_MIN_FEE: '1000' };
  assert.equal(readConfig(base).relay, null);
  assert.deepEqual(readConfig({ ...base, ...relay }).relay, { accountId: 'relayer.testnet', key: secret, minFee: 1000n, maxFee: 100_000n, swapCostBps: 150n, keyAllowanceAlert: 10n ** 24n });
  assert.equal(readConfig({ ...base, ...relay, RELAY_SWAP_COST_BPS: '0' }).relay!.swapCostBps, 0n);
  assert.equal(readConfig({ ...base, ...relay, RELAY_KEY_ALLOWANCE_ALERT_NEAR: '2.5' }).relay!.keyAllowanceAlert, 25n * 10n ** 23n);
  assert.throws(() => readConfig({ ...base, ...relay, RELAY_KEY_ALLOWANCE_ALERT_NEAR: 'lots' }), /RELAY_KEY_ALLOWANCE_ALERT_NEAR/);
  assert.equal(readConfig({ ...base, ...relay, RELAY_SWAP_COST_BPS: '500' }).relay!.swapCostBps, 500n);
  for (const bps of ['-1', '1.5', 'abc', '2001']) assert.throws(() => readConfig({ ...base, ...relay, RELAY_SWAP_COST_BPS: bps }), /RELAY_SWAP_COST_BPS/, bps);
  assert.equal(readConfig({ ...base, ...relay, RELAY_MAX_FEE: '250000' }).relay!.maxFee, 250_000n);
  assert.equal(readConfig({ ...base, ...relay, RELAY_MAX_FEE: '1000' }).relay!.maxFee, 1000n, 'a ceiling equal to the floor fixes the fee');
  for (const max of ['0', '999', '1.5', 'abc']) assert.throws(() => readConfig({ ...base, ...relay, RELAY_MAX_FEE: max }), /RELAY_MAX_FEE/, max);
  assert.throws(() => readConfig({ ...base, ...relay, RELAY_MIN_FEE: '200000' }), /RELAY_MAX_FEE/, 'a floor above the default ceiling needs an explicit ceiling');
  assert.throws(() => readConfig({ ...base, RELAYER_ACCOUNT_ID: 'relayer.testnet' }), /set together/);
  assert.throws(() => readConfig({ ...base, ...relay, RELAY_MIN_FEE: '0' }), /RELAY_MIN_FEE/);
  assert.throws(() => readConfig({ ...base, ...relay, RELAY_MIN_FEE: '1.5' }), /RELAY_MIN_FEE/);
  assert.throws(() => readConfig({ ...base, ...relay, RELAYER_KEY: 'ed25519:' + base58Encode(randomBytes(32)) }), /ed25519 secret key/);
  assert.throws(() => readConfig({ ...base, ...relay, RELAYER_ACCOUNT_ID: 'Relayer' }), /RELAYER_ACCOUNT_ID/);
  for (const contract of ['market.testnet', 'intents.testnet']) {
    assert.throws(() => readConfig({ ...base, ...relay, RELAYER_ACCOUNT_ID: contract }), /must not be one of the deployment contracts/, 'a fee to the market would read as the action');
  }
  assert.throws(() => readConfig({ DATABASE_URL: base.DATABASE_URL, ...relay }), /needs a deployment/);
});

const noQuote = async () => ({ fee: 1000n, validUntil: NOW });
const submitOnly = (submit: Relay['submit']): Relay => ({ submit, quote: noQuote, status: () => ({ keyAllowance: null, keyAllowanceLow: false }) });

async function withApp(relay: Parameters<typeof createApp>[6], run: (post: (body: unknown) => Promise<Response>, root: string) => Promise<void>) {
  const config = readConfig({ DATABASE_URL: 'postgresql://localhost/test' });
  const app = createApp(config, async () => {}, undefined, undefined, undefined, undefined, relay);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}`;
  try {
    await run(body => fetch(root + '/intents/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), root);
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
}

test('the relay route does not exist while the relay is not configured', async () => {
  await withApp(null, async (post, root) => {
    assert.equal((await post({ signed: [] })).status, 404);
    assert.equal((await fetch(root + '/intents/relay', { method: 'OPTIONS' })).status, 404);
    assert.equal((await fetch(root + '/intents/fee')).status, 404);
  });
});

test('the relay route answers hashes, reports the failed index and limits per client and per signer', async () => {
  const seen: string[] = [];
  const handler = async (body: Record<string, unknown>, allowed: (signer: string) => boolean) => {
    const signer = String(body.signer);
    if (!allowed(signer)) throw new RelayError(429, 'signer_rate_limited');
    seen.push(signer);
    if (body.fail) throw new RelayError(422, 'simulation_failed', 1, 'nonce already used');
    if (body.partial) throw Object.assign(new RelayError(502, 'transaction_not_final', 1, undefined, 'h2'), { completed: ['h1'] });
    return { hashes: ['h1'] };
  };
  await withApp(submitOnly(handler), async (post, root) => {
    const ok = await post({ signer: 'a' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { hashes: ['h1'] });
    const failed = await post({ signer: 'b', fail: true });
    assert.equal(failed.status, 422);
    const { error } = await failed.json() as { error: Record<string, unknown> };
    assert.deepEqual({ code: error.code, index: error.index, reason: error.reason }, { code: 'simulation_failed', index: 1, reason: 'nonce already used' });
    const partial = await post({ signer: 'p', partial: true });
    assert.equal(partial.status, 502);
    const partialError = ((await partial.json()) as { error: Record<string, unknown> }).error;
    assert.deepEqual({ code: partialError.code, index: partialError.index, completed: partialError.completed, hash: partialError.hash },
      { code: 'transaction_not_final', index: 1, completed: ['h1'], hash: 'h2' }, 'the client learns what landed and which hash to check');
    assert.equal((await fetch(root + '/intents/relay', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(root + '/intents/relay', { method: 'GET' })).status, 405);
    for (let i = 0; i < 5; i++) assert.equal((await post({ signer: 'c' })).status, 200);
    const limited = await post({ signer: 'c' });
    assert.equal(limited.status, 429, 'five relays per signer in a minute');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(seen, ['a', 'b', 'p', 'c', 'c', 'c', 'c', 'c']);
    const clientLimited = await post({ signer: 'fresh-last' });
    assert.equal(clientLimited.status, 429, 'ten relay requests per client in a minute');
    assert.equal(((await clientLimited.json()) as { error: { code: string } }).error.code, 'rate_limited');
  });
});

test('an oversized relay body is refused before it is parsed', async () => {
  await withApp(submitOnly(async () => ({ hashes: [] })), async post => {
    assert.equal((await post({ signed: ['x'.repeat(9000)] })).status, 413);
  });
});

test('GET /intents/fee answers the current quote with the same origin check and per-client limit as the relay', async () => {
  const validUntil = Date.parse('2026-11-09T12:10:00Z');
  let quotes = 0;
  const relay: Relay = { submit: async () => ({ hashes: [] }), quote: async () => { quotes++; return { fee: 12_345n, validUntil }; }, status: () => ({ keyAllowance: null, keyAllowanceLow: false }) };
  await withApp(relay, async (_post, root) => {
    const answer = await fetch(root + '/intents/fee', { headers: { Origin: 'http://localhost:3400' } });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { fee: '12345', validUntil: '2026-11-09T12:10:00.000Z' });
    assert.equal(answer.headers.get('access-control-allow-origin'), 'http://localhost:3400');
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    const preflight = await fetch(root + '/intents/fee', { method: 'OPTIONS', headers: { Origin: 'http://localhost:3400' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
    assert.equal((await fetch(root + '/intents/fee', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
    const post = await fetch(root + '/intents/fee', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    for (let i = 1; i < 10; i++) assert.equal((await fetch(root + '/intents/fee')).status, 200);
    const limited = await fetch(root + '/intents/fee');
    assert.equal(limited.status, 429, 'ten quotes per client in a minute');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(quotes, 10);
    assert.equal((await fetch(root + '/intents/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200,
      'quotes do not spend the relay budget');
  });
});

const USD18 = (dollars: string) => decimal(dollars, 18);
const settings: FeeSettings = { minFee: 1000n, maxFee: 100_000n, decimals: 6 };

test('the required fee is the gas of the costliest action at the RPC gas price, priced in collateral with a 1.5x margin, never below the floor', () => {
  assert.equal(requiredFee(100_000_000n, USD18('3'), settings), 9000n, '20 TGas x 1e8 yocto = 0.002 NEAR = $0.006 at $3, x 1.5 = 0.009 USDC');
  assert.equal(requiredFee(100_000_000n, USD18('2.5'), settings), 7500n);
  assert.equal(requiredFee(100_000_000n, USD18('3.0000001'), settings), 9001n, 'rounded up, never down');
  assert.equal(requiredFee(100_000_000n, USD18('0.2'), settings), 1000n, '600 units is below the floor');
  assert.equal(requiredFee(100_000_000n, USD18('100'), settings), 300_000n, 'above the ceiling, which the quoter refuses rather than caps');
  assert.equal(requiredFee(10n ** 12n, USD18('3'), settings), 90_000_000n, 'a gas price 10000x the minimum is not capped either');
  assert.equal(requiredFee(100_000_000n, USD18('3'), { ...settings, decimals: 8, maxFee: 10n ** 7n }), 900_000n, 'priced in the collateral\'s own decimals');
});

test('the required fee also covers swapping the collected collateral back into NEAR', () => {
  assert.equal(requiredFee(100_000_000n, USD18('3'), { ...settings, swapCostBps: 150n }), 9135n, '9000 plus 1.5% for the swap');
  assert.equal(requiredFee(100_000_000n, USD18('3'), { ...settings, swapCostBps: 1n }), 9001n, 'rounded up, never down');
  assert.equal(requiredFee(100_000_000n, USD18('0.2'), { ...settings, swapCostBps: 150n }), 1000n, 'the floor still holds');
  assert.equal(requiredFee(100_000_000n, USD18('100'), { ...settings, swapCostBps: 150n }), 304_500n, 'and above the ceiling it is not capped');
});

test('the fee never falls below one action\'s cost at floor gas, whatever the floor setting and whatever price the median returns', async () => {
  const cost = (price: bigint, decimals: number) => (GAS_PER_ACTION * MIN_GAS_PRICE * price * 10n ** BigInt(decimals) + 10n ** 42n - 1n) / 10n ** 42n;
  const prices = ['0.0001', '0.01', '0.2', '1', '3', '27.5', '1000', '250000'];
  for (const decimals of [6, 8, 18]) {
    for (const quoted of prices) {
      const price = medianPrice([quoted, quoted]);
      const open = { minFee: 1n, maxFee: 10n ** 40n, decimals };
      assert.ok(requiredFee(MIN_GAS_PRICE, price, open) >= cost(price, decimals), `${quoted} at ${decimals} decimals`);
      const quoter = createFeeQuoter(open, { nearUsd: async () => price, gasPrice: async () => MIN_GAS_PRICE });
      assert.ok((await quoter.quote()).fee >= cost(price, decimals));
      assert.ok(await quoter.accepted() >= cost(price, decimals));
    }
  }
});

test('the NEAR price is the median of at least two sources that agree within 5% and are a majority of those that answered', () => {
  assert.equal(medianPrice(['3.00', '3.10']), USD18('3.05'));
  assert.equal(medianPrice(['3.01', '2.99', '3.05']), USD18('3.01'));
  assert.equal(medianPrice(['3.00', '3.15']), USD18('3.075'), '2.4% from the median is agreement');
  assert.throws(() => medianPrice(['3.00']), /fewer than two/);
  assert.throws(() => medianPrice([]), /fewer than two/);
  assert.throws(() => medianPrice(['3.00', '3.40']), /disagree/, 'one source 6.25% from the median refuses the price');
  assert.equal(medianPrice(['3.00', '3.01', '3.02', '9.99']), USD18('3.01'), 'a single broken source is outvoted by three that agree');
  assert.throws(() => medianPrice(['3.00', '3.01', '9.98', '9.99']), /disagree/, 'two against two is no majority');
});

test('the NEAR price waits for every source and uses the ones that answered', async () => {
  const ok = (price: string) => async () => ({ price });
  const down = async (): Promise<{ price: string }> => { throw new Error('price_source_unavailable'); };
  assert.equal(await nearUsdFrom([ok('3.00'), down, ok('3.02'), down, ok('3.04')])(), USD18('3.02'));
  await assert.rejects(nearUsdFrom([ok('3.00'), down, down, down, down])(), /fewer than two/);
  await assert.rejects(nearUsdFrom([ok('3.00'), ok('4.00'), down])(), /disagree/);
});

function clockedQuoter(start = NOW, over: Partial<FeeSettings> = {}) {
  const clock = { now: start, usd: '3' as string | null, gas: 100_000_000n as bigint | null, reads: 0 };
  const quoter = createFeeQuoter({ ...settings, ...over }, {
    nearUsd: async () => { clock.reads++; if (clock.usd === null) throw new Error('outage'); return USD18(clock.usd); },
    gasPrice: async () => { if (clock.gas === null) throw new Error('rpc down'); return clock.gas; },
  }, () => clock.now);
  return { clock, quoter };
}
const minutes = (n: number) => n * 60_000;

test('a quote is cached for 60 seconds, valid for ten minutes, and refreshed once for many concurrent callers', async () => {
  const { clock, quoter } = clockedQuoter();
  assert.deepEqual(await quoter.quote(), { fee: 9000n, validUntil: NOW + minutes(10) });
  clock.usd = '4';
  clock.now += 59_999;
  assert.deepEqual(await quoter.quote(), { fee: 9000n, validUntil: NOW + minutes(10) }, 'still cached');
  assert.equal(clock.reads, 1);
  clock.now += 1;
  const all = await Promise.all([quoter.quote(), quoter.quote(), quoter.quote(), quoter.accepted()]);
  assert.equal(clock.reads, 2, 'one refresh for four callers');
  assert.deepEqual(all.slice(0, 3), Array(3).fill({ fee: 12_000n, validUntil: NOW + 60_000 + minutes(10) }));
});

test('a rising price: a fee quoted in the last ten minutes is still accepted, and only then the new price applies', async () => {
  const { clock, quoter } = clockedQuoter();
  assert.equal((await quoter.quote()).fee, 9000n);
  clock.usd = '4';
  clock.now += minutes(3);
  assert.equal((await quoter.quote()).fee, 12_000n);
  assert.equal(await quoter.accepted(), 9000n, 'the user who signed at $3 is not refused');
  clock.now = NOW + minutes(10) - 1;
  assert.equal(await quoter.accepted(), 9000n);
  clock.now = NOW + minutes(10);
  assert.equal(await quoter.accepted(), 12_000n, 'the $3 quote has outlived every signature made with it');
});

test('a falling price lowers the accepted fee at once', async () => {
  const { clock, quoter } = clockedQuoter();
  await quoter.quote();
  clock.usd = '2';
  clock.now += minutes(1);
  assert.equal(await quoter.accepted(), 6000n);
  assert.equal((await quoter.quote()).fee, 6000n);
});

test('an outage keeps the last good price for an hour, then charges the ceiling, never the floor', async () => {
  const { clock, quoter } = clockedQuoter();
  await quoter.quote();
  clock.usd = null;
  clock.now += minutes(30);
  assert.equal((await quoter.quote()).fee, 9000n, 'the last good price, 30 minutes old');
  assert.equal(clock.reads, 2);
  clock.now += 30_000;
  await quoter.quote();
  assert.equal(clock.reads, 2, 'a failed refresh is not retried for 60 seconds');
  clock.now = NOW + minutes(60);
  assert.equal((await quoter.quote()).fee, 9000n, 'exactly an hour old is still used');
  clock.now = NOW + minutes(61);
  assert.equal((await quoter.quote()).fee, 100_000n, 'past an hour: the ceiling');
  assert.equal(await quoter.accepted(), 9000n, 'a fee quoted from the last good price in the last ten minutes still passes');
  clock.now = NOW + minutes(72);
  assert.equal(await quoter.accepted(), 100_000n);
  clock.usd = '3';
  clock.now += minutes(1);
  assert.equal((await quoter.quote()).fee, 9000n, 'back to the market price once a source answers');
});

test('a gas price the RPC will not give is an outage too', async () => {
  const { clock, quoter } = clockedQuoter();
  clock.gas = null;
  assert.equal((await quoter.quote()).fee, 100_000n, 'no good price yet: the ceiling');
  clock.gas = 200_000_000n;
  clock.now += minutes(1);
  assert.equal((await quoter.quote()).fee, 18_000n, 'twice the gas price, twice the fee');
});

test('sources that disagree count as no price', async () => {
  let prices = ['3.00', '3.02'];
  const quoter = createFeeQuoter(settings, { nearUsd: nearUsdFrom([0, 1].map(i => async () => ({ price: prices[i]! }))), gasPrice: async () => 100_000_000n }, () => clock);
  let clock = NOW;
  assert.equal((await quoter.quote()).fee, 9030n);
  prices = ['3.00', '30.0'];
  clock += minutes(1);
  assert.equal((await quoter.quote()).fee, 9030n, 'the last good price, not the median of a broken pair');
});

test('the accepted fee is never below the floor, nothing is accepted above the ceiling, and the window stays bounded', async () => {
  const cheap = clockedQuoter(NOW, { minFee: 5000n });
  cheap.clock.usd = '0.01';
  assert.equal(await cheap.quoter.accepted(), 5000n);
  const dear = clockedQuoter(NOW, { maxFee: 20_000n });
  dear.clock.usd = '1000';
  await assert.rejects(dear.quoter.accepted(), FeeAboveCeiling);
  const { clock, quoter } = clockedQuoter();
  for (let i = 0; i < 500; i++) {
    clock.usd = String(3 + (i % 7) / 10);
    clock.now += 60_000;
    await quoter.accepted();
  }
  clock.usd = '4';
  clock.now += 60_000;
  assert.equal(await quoter.accepted(), 9000n, 'the lowest of the last ten minutes, not of all 500');
  clock.usd = '9';
  clock.now += 60_000;
  assert.equal(await quoter.accepted(), 27_000n, 'a rise past the margin: no earlier quote covers the cost any more');
});

function relayKeyText() {
  const { privateKey, publicKey: pub } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return 'ed25519:' + base58Encode(Buffer.concat([seed, pub.export({ type: 'spki', format: 'der' }).subarray(-32)]));
}

function gatedRelay(balance: (params: Record<string, unknown>) => Promise<unknown>, accepted = 1000n) {
  const log: string[] = [];
  const view = (bytes: string) => ({ result: [...Buffer.from(bytes)], logs: [], block_height: 1, block_hash: 'x' });
  const rpc: RelayRpc = {
    primary: { call: async method => { log.push(`primary ${method}`); throw new RpcError('transport_or_timeout'); } },
    second: null,
    reads: { call: async (method, params) => {
      const p = params as Record<string, unknown>;
      log.push(`reads ${method} ${String(p.method_name)} ${p.args_base64 ? Buffer.from(String(p.args_base64), 'base64').toString() : ''}`);
      return view(JSON.stringify(await balance(p)));
    } },
    sendUrl: 'http://127.0.0.1:1', requireSecond: false,
  };
  const relay = createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'gate', DEPLOYMENT_START_BLOCK: '1',
    COLLATERAL_TOKEN_ID: context.collateral, VERIFIER_CONTRACT_ID: context.verifier, MARKET_CONTRACT_ID: context.market, ORACLE_CONTRACT_ID: context.oracle!,
    RELAYER_ACCOUNT_ID: context.relayer, RELAYER_KEY: relayKeyText(), RELAY_MIN_FEE: '1000' }), rpc,
    { quote: async () => ({ fee: accepted, validUntil: NOW }), accepted: async () => { log.push('accepted'); return accepted; } })!;
  const slots: string[] = [];
  const allow = (signer: string) => { slots.push(signer); return true; };
  return { relay, log, slots, allow };
}

const livePayload = (intents: object[]) => JSON.stringify({ signer_id: EVM, verifying_contract: context.verifier, deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  nonce: randomBytes(32).toString('base64'), intents });

test('a signer whose verifier balance cannot cover every transfer of the request is charged its signer limit, then refused before the queue', async () => {
  const { relay, log, slots, allow } = gatedRelay(async () => '6001999');
  const register = evm(livePayload([move(context.market, '1000000', { msg: 'register' }), fee()]));
  const trade = evm(livePayload([buy('buy:3:yes:1', '5000000'), fee()]));
  await assert.rejects(relay.submit({ signed: [register, trade] }, allow),
    (error: unknown) => error instanceof RelayError && error.status === 422 && error.code === 'insufficient_balance' && error.index === undefined);
  assert.deepEqual(slots, [EVM], 'the per-signer limit is charged before the balance read, so an unfunded replay is not free');
  assert.deepEqual(log, ['accepted', `reads query mt_balance_of {"account_id":"${EVM}","token_id":"${context.collateral}"}`], 'one balance read, nothing on the simulate path');
  log.length = 0;
  const funded = gatedRelay(async () => '6002000');
  await assert.rejects(funded.relay.submit({ signed: [register, trade] }, funded.allow), (error: unknown) => error instanceof RelayError && error.code === 'rpc_unavailable');
  assert.deepEqual(funded.slots, [EVM], 'exactly enough for 1 + 5 + two fees of 0.001 passes the gate into the queue');
  assert.ok(funded.log.includes('primary query'), 'and reaches simulation');
});

test('a fee below the lowest fee quoted in the last ten minutes is refused before the balance read', async () => {
  const { relay, log, slots, allow } = gatedRelay(async () => '100000000', 5000n);
  await assert.rejects(relay.submit({ signed: [evm(livePayload([buy(), fee('5000')])), evm(livePayload([buy(), fee('4999')]))] }, allow),
    (error: unknown) => error instanceof RelayError && error.status === 422 && error.code === 'fee_too_low' && error.index === 1 && error.reason === '5000');
  assert.deepEqual(log, ['accepted']);
  assert.deepEqual(slots, []);
  refusedWith('invalid_fee', () => validateItem(evm(livePayload([buy(), fee('999')])), context, Date.now(), 0));
});

test('balance reads are bounded: one in flight per signer, sixteen in all, and the overflow is refused at once, never queued behind simulation', async () => {
  const waiting: (() => void)[] = [];
  const { relay, slots, allow } = gatedRelay(() => new Promise(resolve => waiting.push(() => resolve('0'))));
  const signers = Array.from({ length: 17 }, () => evmKey());
  const item = (key: ReturnType<typeof evmKey>) => evm(JSON.stringify({ ...JSON.parse(livePayload([buy(), fee()])), signer_id: key.address }), {}, key);
  const flood = signers.slice(0, 16).map(key => relay.submit({ signed: [item(key)] }, allow).catch((error: RelayError) => error.code));
  await new Promise(resolve => setImmediate(resolve));
  const busy = (error: unknown) => error instanceof RelayError && error.status === 503 && error.code === 'relay_busy';
  await assert.rejects(relay.submit({ signed: [item(signers[0]!)] }, allow), busy, 'a second request from a signer with a read in flight');
  await assert.rejects(relay.submit({ signed: [item(signers[16]!)] }, allow), busy, 'a seventeenth signer while sixteen reads are in flight');
  for (const release of waiting) release();
  assert.deepEqual(await Promise.all(flood), Array(16).fill('insufficient_balance'));
  assert.equal(slots.length, 18, 'every request was charged its signer limit before any read');
});

test('a balance read that fails refuses the request as unavailable', async () => {
  const { relay, slots, allow } = gatedRelay(async () => { throw new RpcError('transport_or_timeout'); });
  await assert.rejects(relay.submit({ signed: [evm(livePayload([buy(), fee()]))] }, allow), (error: unknown) => error instanceof RelayError && error.status === 503 && error.code === 'rpc_unavailable');
  assert.deepEqual(slots, [EVM]);
});
