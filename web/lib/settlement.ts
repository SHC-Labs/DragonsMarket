// Read-only display math. Unknown final parameters stay unknown, never default to 50/50.
export function voidPayout(yes: bigint, no: bigint, price: string | null | undefined): bigint | null {
  if (price == null || !/^\d+$/.test(price)) return null;
  const p = BigInt(price);
  if (p > 1_000_000n) return null;
  return (yes * p + no * (1_000_000n - p)) / 1_000_000n;
}
export function netSellProceeds(quote: { collateral_out: string; fee: string }): bigint {
  const gross = BigInt(quote.collateral_out), fee = BigInt(quote.fee);
  if (fee < 0n || gross < fee) throw new Error("Invalid sell quote");
  return gross - fee;
}
