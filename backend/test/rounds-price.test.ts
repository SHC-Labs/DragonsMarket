import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';
import { base58Encode } from '../src/base58.js';
import { loadPublisherKey, roundPriceMessage } from '../src/round-publisher.js';

// Separate from routine unit tests: starts an actual node and deploys the unchanged rounds WASM (npm run build:local-contract).
test('a price signed by the backend publisher key is accepted by the real rounds contract, and a different price is not', { timeout: 180000 }, async () => {
  const wasm = await readFile('.local/wasm/rounds.wasm').catch(() => {
    throw new Error('Build the rounds WASM first: npm run build:local-contract');
  });
  await mkdir('.local/tmp', { recursive: true });
  const previousTmp = process.env.TMPDIR,
    previousBin = process.env.DIR_TO_DOWNLOAD_BINARY;
  process.env.TMPDIR = resolve('.local/tmp');
  process.env.DIR_TO_DOWNLOAD_BINARY = resolve('.local/sandbox-bin');
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.start({ version: '2.13.4' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const owner = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as KeyPairString);
    const roundsKey = KeyPair.fromRandom('ed25519'),
      aliceKey = KeyPair.fromRandom('ed25519');
    const contractId = `rounds.${DEFAULT_ACCOUNT_ID}`,
      aliceId = `alice.${DEFAULT_ACCOUNT_ID}`;
    await owner.createAccount({ newAccountId: contractId, publicKey: roundsKey.getPublicKey(), nearToTransfer: nearToYocto('40') });
    await owner.createAccount({ newAccountId: aliceId, publicKey: aliceKey.getPublicKey(), nearToTransfer: nearToYocto('10') });
    const rounds = new Account(contractId, provider, roundsKey.toString());
    const alice = new Account(aliceId, provider, aliceKey.toString());
    await rounds.deployContract(wasm);
    const collateral = `nep141:usdc.${DEFAULT_ACCOUNT_ID}`;
    const send = async (signer: Account, method: string, args: object) => {
      const result = await signer.signAndSendTransaction({
        receiverId: contractId,
        actions: [actions.functionCall(method, args, teraToGas('100'))],
        waitUntil: 'FINAL',
        throwOnFailure: false,
      });
      return typeof result.status === 'object' && result.status !== null && 'Failure' in result.status ? JSON.stringify(result.status) : null;
    };
    assert.equal(
      await send(rounds, 'new', {
        owner_id: owner.accountId,
        operator_id: owner.accountId,
        verifier_id: owner.accountId,
        collateral_token_id: collateral,
        network: 'sandbox',
        price_threshold: 1,
      }),
      null,
    );

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = loadPublisherKey(
      `ed25519:${base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]))}`,
    );
    assert.equal(await send(owner, 'add_publisher', { key: key.publicKey }), null);

    const head = await provider.viewBlock({ finality: 'final' });
    const chainNow = BigInt(head.header.timestamp_nanosec);
    const firstStart = chainNow - 30n * 10n ** 9n;
    assert.equal(
      await send(owner, 'add_series', {
        asset: 'btc-usd',
        decimals: 8,
        first_start: firstStart.toString(),
        interval: String(3600n * 10n ** 9n),
        price_window: String(600n * 10n ** 9n),
        close_before: String(60n * 10n ** 9n),
      }),
      null,
    );

    // The owner stands in for the verifier here, so it can deliver alice's money: register her, then stake in round 0.
    const deliver = (msg: string, amount: string) =>
      send(owner, 'mt_on_transfer', { sender_id: aliceId, previous_owner_ids: [aliceId], token_ids: [collateral], amounts: [amount], msg });
    assert.equal(await deliver('register', '250000'), null);
    assert.equal(await deliver('stake:0:0:up:0', '1000000'), null);

    const price = '8080944000000';
    const message = roundPriceMessage(contractId, 'sandbox', 'btc-usd', firstStart.toString(), price, 8);
    const entry = `${key.publicKey}.${key.sign(message)}`;
    assert.match(
      (await send(alice, 'record_price', { series_id: 0, round: '0', price: '8080944000001', signatures: entry }))!,
      /does not match/,
      'a signature over another price records nothing',
    );
    assert.equal(await send(alice, 'record_price', { series_id: 0, round: '0', price, signatures: entry }), null);
    assert.equal(await provider.callFunction({ contractId, method: 'get_price', args: { series_id: 0, round: '0' } }), price);
    assert.match((await send(alice, 'record_price', { series_id: 0, round: '0', price, signatures: entry }))!, /already recorded/);
  } finally {
    await sandbox?.tearDown();
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    if (previousBin === undefined) delete process.env.DIR_TO_DOWNLOAD_BINARY;
    else process.env.DIR_TO_DOWNLOAD_BINARY = previousBin;
  }
});
