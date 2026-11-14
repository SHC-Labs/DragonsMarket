import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTACKER, USD, USDC, attempt, harness } from './topup-harness.js';

test('a REFUNDED status whose refund never reached the Intents account does not clear the journal and fund the next deposit', async () => {
  const h = harness({ oneClick: { statuses: ['REFUNDED'], depositAddress: ATTACKER } });
  const states = [];
  for (let run = 0; run < 4; run++) states.push(await attempt(h.run()));
  assert.deepEqual(h.chain.transfers.map(t => [t.receiver, t.amount]), [[ATTACKER, 20n * USD]],
    `one deposit at most may go to an address that only 1Click vouches for; runs ended ${JSON.stringify(states)}`);
  assert.equal(h.chain.balances.get(USDC), 30n * USD, 'the rest of the collateral stays home');
});
