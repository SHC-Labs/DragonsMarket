import test from 'node:test';
import assert from 'node:assert/strict';
import { NEAR, attempt, harness, keyText, publicOf } from './topup-harness.js';

test('a COLLATERAL_DECIMALS typo does not switch the price check off: a quote at 100x the median is refused', async () => {
  const h = harness({ settings: { collateralDecimals: 18 }, oneClick: { usdPerNear: 300 } });
  const state = await attempt(h.run());
  assert.equal(h.chain.broadcasts.length, 0, `paid $300 a NEAR against a $3 median; run ended ${state}`);
});

test('a submit key with no allowance is refused: leaked, it could burn every native NEAR of the relayer on gas', async () => {
  const h = harness();
  h.chain.submitAllowance = null;
  assert.equal(await attempt(h.run()), 'submit_key_invalid');
  assert.equal(h.click.requests.length, 0);
});

test('an extra key in the relayer intents key set (added by a leaked treasury key, or anyone else) stops the job', async () => {
  const h = harness();
  h.chain.keys.add(publicOf(keyText()));
  const state = await attempt(h.run());
  assert.equal(h.chain.broadcasts.length, 0, `a second signer can already move the whole balance; run ended ${state}`);
});

test('dust wNEAR sent to the relayer by a stranger is not withdrawn on every run at the relayer gas cost', async () => {
  const h = harness();
  h.chain.native = 5n * NEAR;
  h.chain.balances.set('nep141:wrap.near', 1n);
  await attempt(h.run());
  assert.equal(h.chain.broadcasts.length, 0, 'a 1 yoctoNEAR native_withdraw was signed and paid for');
});
