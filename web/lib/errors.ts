// Contract panic text -> a sentence a person can act on. Matches the failure copy in the design notes.
const RULES: [RegExp, string][] = [
  [/has not closed/i, "This market is still open. Wait until trading closes."],
  [/market is closed/i, "Trading has closed on this market."],
  [/market is resolved/i, "This market already has a final result."],
  [/too many positions/i, "You have reached the position limit. Close an existing position before opening another."],
  [/min shares must be above zero/i, "This amount is too small to trade. Enter a larger amount."],
  [/paused/i, "Trading is paused. Your balance is safe."],
  [/market is halted/i, "This market is paused. Your balance is safe."],
  [/price moved/i, "The price moved. You would get less than your minimum. Try again."],
  [/not enough balance|not enough shares/i, "You do not have enough for this."],
  [/storage deposit/i, "Do the one-time storage step first."],
  [/wrong token/i, "This market uses a different token."],
  [/not registered with the oracle/i, "This market is not ready yet."],
  [/no liquidity|no such market|cannot buy|cannot sell/i, "This trade is not possible right now."],
];

export function friendlyError(panic: string | null, reference: string): string {
  const known = panic ? RULES.find(([re]) => re.test(panic)) : undefined;
  if (known) return known[1];
  return `The transaction could not be confirmed. Check its final status before trying again. Reference ${reference}.`;
}

export const shortRef = (txHash: string) => txHash.slice(0, 6);
