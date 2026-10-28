// Read-only display math.
export function netSellProceeds(quote: { collateral_out: string; fee: string }): bigint {
  const gross = BigInt(quote.collateral_out), fee = BigInt(quote.fee);
  if (fee < 0n || gross < fee) throw new Error("Invalid sell quote");
  return gross - fee;
}
