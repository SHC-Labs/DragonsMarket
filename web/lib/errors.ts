// Contract panic text -> a sentence a person can act on. Matches the failure copy in the design notes.
const RULES: [RegExp, string][] = [
  [/has not closed/i, "This market is still open. Wait until trading closes."],
  [/market is closed/i, "Trading has closed on this market."],
  [/market is resolved/i, "This market already has a final result."],
  [/too many positions/i, "You have reached the position limit. Close an existing position before opening another."],
  [/min shares must be above zero/i, "This amount is too small to trade. Enter a larger amount."],
  [/sells are paused/i, "Selling is paused right now. Buying may still work."],
  [/paused/i, "Trading is paused. Check the market status before trying again."],
  [/market is halted/i, "This market is paused. Check its status before trying again."],
  [/price moved/i, "The price moved. You would get less than your minimum. Try again."],
  [/not enough balance|not enough shares/i, "You do not have enough for this."],
  [/storage deposit/i, "Complete the one-time storage setup before trading."],
  [/wrong token/i, "This market uses a different token."],
  [/not registered with the oracle/i, "This market is not ready yet."],
  [/no liquidity|no such market|cannot buy|cannot sell/i, "This trade is not possible right now."],
  [/the money must come from the sender's own balance|only the verifier can deliver money|exactly one token and amount/i, "That transfer was refused. Send it from your own Intents balance."],
  [/bad min shares|unknown action|bad market id/i, "That request was malformed. Reload the page and try again."],
  [/send exactly the bond/i, "Send exactly the bond amount."],
  [/an answer was already proposed|nothing to challenge/i, "There is no open answer to propose or challenge on this market."],
  [/too late to propose/i, "It is too late to propose an answer. The market will be voided at its deadline."],
  [/the challenge window closed/i, "The challenge window has closed."],
  [/you cannot challenge your own answer|a challenge must name a different answer/i, "A challenge must come from another account and name a different answer."],
  [/outcome must be yes, no or void/i, "The answer must be yes, no or void."],
  [/not on the panel for this case/i, "You are not on the jury for this case."],
  [/the commit phase is over/i, "The commit phase is over."],
  [/the commit phase is still open/i, "Reveals open when the commit phase ends."],
  [/the panel deadline passed/i, "The jury deadline has passed."],
  [/already committed|already revealed/i, "You already voted on this case."],
  [/the vote does not match the commitment/i, "That vote and salt do not match what you committed."],
  [/vote for the proposed answer or the challenger's answer/i, "Vote for the proposed answer or the challenger's answer."],
  [/a reason is required/i, "Give a reason for your vote."],
  [/commitment must be 64 lowercase hex characters/i, "The commitment is malformed. Reload the page and try again."],
  [/that token is not on the allowlist/i, "That token is not eligible for a Council seat."],
  [/already staked/i, "That token is already staked."],
  [/the council is full|already holds the most seats allowed/i, "No more seats can be staked right now."],
  [/this seat is serving on an open case/i, "This seat is serving on an open case and cannot leave until it ends."],
  [/the cooldown has not passed/i, "The unstake cooldown has not passed yet."],
  [/request an unstake first/i, "Request the unstake first, then wait out the cooldown."],
  [/nothing to claim|already claimed/i, "There is nothing left to claim for that quarter."],
  [/claim is already pending/i, "That claim is already on its way."],
  [/that quarter is not final/i, "That quarter is still open. Claims open when it is final."],
  [/a withdrawal is still pending/i, "A withdrawal is still on its way. Wait for it to finish, then try again."],
  [/a jury drawn in this quarter is still open/i, "A jury drawn in this quarter is still open. This quarter closes when that case ends."],
  [/attach at least (\d+) TGas/i, "This needed more gas than was attached. Try again."],
];

// The gas a refusal asks for, in TGas, so a caller can retry with it.
export function requiredGasTgas(panic: string | null): number | null {
  const m = panic?.match(/attach at least (\d+) TGas/i);
  return m ? Number(m[1]) : null;
}

export function friendlyError(panic: string | null, reference: string): string {
  const known = panic ? RULES.find(([re]) => re.test(panic)) : undefined;
  if (known) return known[1];
  return `The transaction could not be confirmed. Check its final status before trying again. Reference ${reference}.`;
}

export const shortRef = (txHash: string) => txHash.slice(0, 6);
