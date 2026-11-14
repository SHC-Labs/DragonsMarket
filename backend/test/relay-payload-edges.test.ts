import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { base58Decode, base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import { RpcError } from '../src/providers.js';
import { RelayError, createRelay, validateItem, type RelayContext, type RelayRpc } from '../src/relay.js';

const context: RelayContext = { verifier: 'intents.near', collateral: 'nep141:usdc.near', market: 'market.near', oracle: 'oracle.near', relayer: 'relayer.near', minFee: 1000n, maxFee: 100_000n };
const NOW = Date.parse('2026-11-09T12:00:00Z');
const move = (to: string, amount: string, extra: object = {}) => ({ intent: 'transfer', receiver_id: to, tokens: { [context.collateral]: amount }, ...extra });
const fee = () => move(context.relayer, '1000');
const register = () => move(context.market, '5000000', { msg: 'register' });
const payload = (signer: string, intents: object[], deadline = new Date(NOW + 5 * 60_000).toISOString()) =>
  JSON.stringify({ signer_id: signer, verifying_contract: context.verifier, deadline, nonce: randomBytes(32).toString('base64'), intents });

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { id: raw.toString('hex'), item: (text: string) => ({ standard: 'raw_ed25519', payload: text, public_key: `ed25519:${base58Encode(raw)}`,
    signature: `ed25519:${base58Encode(sign(null, Buffer.from(text), privateKey))}` }) };
}

const refused = (run: () => unknown) => assert.throws(run, (error: unknown) => error instanceof RelayError && error.status === 400);

test('a forged signature under a weak (small-order) ed25519 key is refused locally, as intents.near refuses it', () => {
  // The identity point: R = identity and S = 0 verify for every message under OpenSSL, which does not reject weak keys.
  const weak = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
  const forged = (text: string) => ({ standard: 'raw_ed25519', payload: text, public_key: `ed25519:${base58Encode(weak)}`,
    signature: `ed25519:${base58Encode(Buffer.concat([weak, Buffer.alloc(32)]))}` });
  for (const intents of [[register(), fee()], [move(context.market, '1', { msg: 'buy:1:yes:1' }), fee()]]) {
    refused(() => validateItem(forged(payload(weak.toString('hex'), intents)), context, NOW, 0));
  }
});

test('a lone surrogate escape in propose evidence is refused locally, as serde_json refuses it inside intents.near', () => {
  const signer = ed25519();
  const text = payload(signer.id, [move(context.oracle!, '5000000', { msg: 'propose:market.near:4:yes:https://e.com/\ud800' }), fee()]);
  assert.ok(text.includes('\\ud800'), 'JSON.stringify writes the lone surrogate as an escape, so the canonical check passes it');
  refused(() => validateItem(signer.item(text), context, NOW, 0));
});

test('held: an ed25519 signature with S + L (non-canonical S) is refused locally', () => {
  const signer = ed25519();
  const text = payload(signer.id, [register(), fee()]);
  const good = signer.item(text);
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const raw = Buffer.from(base58Decode(good.signature.slice('ed25519:'.length)));
  const s = BigInt('0x' + Buffer.from(raw.subarray(32)).reverse().toString('hex')) + L;
  const twin = Buffer.concat([raw.subarray(0, 32), Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse()]);
  refused(() => validateItem({ ...good, signature: `ed25519:${base58Encode(twin)}` }, context, NOW, 0));
  validateItem(good, context, NOW, 0);
});

test('held: a __proto__ key anywhere in the payload is refused', () => {
  const signer = ed25519();
  const base = payload(signer.id, [register(), fee()]);
  for (const text of [base.replace('{"signer_id"', '{"__proto__":{},"signer_id"'), base.replace('"tokens":{', '"tokens":{"__proto__":"1",')]) {
    refused(() => validateItem(signer.item(text), context, NOW, 0));
  }
});

test('the relay does not send a payload with too little life left to land, even when its simulation passed', async () => {
  const signer = ed25519();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const sends: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: string; method: string };
      sends.push(method);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const text = payload(signer.id, [register(), fee()], new Date(clock + 61_000).toISOString());
    const deadline = clock + 61_000;
    const primary: RelayRpc['primary'] = { call: async (method, params) => {
      const p = params as Record<string, unknown>;
      if (method === 'query' && p.method_name === 'simulate_intents') {
        // The queue reached this item 60.5 s after validation; the simulation still sees half a second of life and passes.
        clock = deadline - 500;
        return { result: [...Buffer.from('{}')], logs: [] };
      }
      if (method === 'query' && p.request_type === 'view_access_key') {
        return { nonce: 7, permission: { FunctionCall: { receiver_id: context.verifier, method_names: ['execute_intents'], allowance: null } } };
      }
      if (method === 'block') return { header: { hash: base58Encode(randomBytes(32)) } };
      throw new RpcError('transport_or_timeout');
    } };
    const keyPair = generateKeyPairSync('ed25519');
    const seed = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
    const relayerKey = 'ed25519:' + base58Encode(Buffer.concat([seed, keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]));
    const rpc: RelayRpc = { primary, second: null, reads: { call: async () => ({ result: [...Buffer.from('"100000000"')], logs: [] }) },
      sendUrl: `http://127.0.0.1:${address.port}`, requireSecond: false };
    const relay = createRelay(readConfig({ DATABASE_URL: 'postgresql://localhost/test', NETWORK: 'sandbox', DEPLOYMENT_ID: 'rt', DEPLOYMENT_START_BLOCK: '1',
      COLLATERAL_TOKEN_ID: context.collateral, VERIFIER_CONTRACT_ID: context.verifier, MARKET_CONTRACT_ID: context.market, ORACLE_CONTRACT_ID: context.oracle!,
      RELAYER_ACCOUNT_ID: context.relayer, RELAYER_KEY: relayerKey, RELAY_MIN_FEE: '1000' }), rpc,
      { quote: async () => ({ fee: 1000n, validUntil: clock }), accepted: async () => 1000n })!;
    const outcome = await relay.submit({ signed: [signer.item(text)] }, () => true).then(() => 'ok', (error: unknown) => error instanceof RelayError ? error.code : String(error));
    assert.deepEqual(sends, [], `the relay broadcast a transaction with 500 ms of payload life left (outcome ${outcome}); it cannot land before intents.near checks the deadline`);
  } finally {
    Date.now = realNow;
    server.close();
  }
});
