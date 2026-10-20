const MICRO = 1_000_000n;

// "12.5" -> 12500000n. Null for anything that is not a plain amount with at most six decimals.
export function toMicro(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, "0"));
}

export function formatMicro(value: bigint | string, decimals = 2): string {
  const v = typeof value === "string" ? BigInt(value) : value;
  const factor = 10n ** BigInt(6 - decimals);
  const rounded = (v + factor / 2n) / factor;
  const whole = rounded / 10n ** BigInt(decimals);
  const frac = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return decimals === 0 ? whole.toString() : `${whole.toLocaleString("en-US")}.${frac}`;
}

export const formatMoney = (v: bigint | string) => formatMicro(v, 2);
export const formatShares = (v: bigint | string) => formatMicro(v, 1);

// Price in millionths of one unit -> "62¢".
export function cents(priceMicro: string | bigint): string {
  const v = typeof priceMicro === "string" ? BigInt(priceMicro) : priceMicro;
  return `${((v + 5_000n) / 10_000n).toString()}¢`;
}

export function shortAccount(id: string, max = 22): string {
  return id.length <= max ? id : `${id.slice(0, 10)}…${id.slice(-8)}`;
}

export function nsToMs(ns: string | bigint): number {
  return Number((typeof ns === "string" ? BigInt(ns) : ns) / 1_000_000n);
}

export function formatDateTime(ns: string | bigint): string {
  return new Date(nsToMs(ns)).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// "2h 14m left", "40s left", or "ended". Updates once a minute above an hour, per the design notes.
export function timeLeft(ns: string | bigint, nowMs: number): string {
  const secs = Math.floor((nsToMs(ns) - nowMs) / 1000);
  if (secs <= 0) return "ended";
  if (secs < 60) return `${secs}s left`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m ${secs % 60}s left`;
}

// Slippage in basis points. The buyer accepts a bit fewer shares; the seller a few more.
export const minSharesWithSlippage = (shares: bigint, bps = 100n) => {
  if (shares <= 0n) return 0n;
  const minimum = (shares * (10_000n - bps)) / 10_000n;
  return minimum < 1n ? 1n : minimum;
};
export const maxSharesWithSlippage = (shares: bigint, bps = 100n) => (shares * (10_000n + bps) + 9_999n) / 10_000n;
