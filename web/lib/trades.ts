import { backendEnabled, call } from "./backend";
import { config } from "./config";
import { chainHeight } from "./rpc";

export type Side = "yes" | "no";
export interface Trade {
  key: string;
  account: string;
  marketId: string;
  kind: "buy" | "sell";
  side: Side;
  collateral: bigint;
  priceYes: number | null;
  at: number;
}

interface EventRow {
  block_height: string;
  block_timestamp_ns: string;
  receipt_id: string;
  log_index: number;
  data_index: number;
  event: string;
  payload: Record<string, unknown>;
}

// The backend indexes every contract event and lists them oldest first, so the feed reads a recent window of blocks
// (about fifteen minutes) and keeps the newest rows of it.
const WINDOW_BLOCKS = 900n;
const UNITS = /^\d{1,39}$/;

function parse(row: EventRow): Trade | null {
  const p = row.payload;
  const side = p.side === "yes" || p.side === "no" ? p.side : null;
  const kind = row.event === "buy" || row.event === "sell" ? row.event : null;
  if (!side || !kind || typeof p.account !== "string" || typeof p.market_id !== "string"
    || typeof p.collateral !== "string" || !UNITS.test(p.collateral)) return null;
  const price = typeof p.price_yes === "string" && UNITS.test(p.price_yes) ? Number(p.price_yes) / 1e6 : null;
  return {
    key: `${row.receipt_id}:${row.log_index}:${row.data_index}`, account: p.account, marketId: p.market_id, kind, side,
    collateral: BigInt(p.collateral), priceYes: price, at: Number(BigInt(row.block_timestamp_ns) / 1_000_000n),
  };
}

/** The latest buys and sells on the market contract, newest first, or null when there is no backend to ask. */
export async function recentTrades(limit = 8, marketId?: string): Promise<Trade[] | null> {
  if (!backendEnabled()) return null;
  const head = await chainHeight();
  const from = head > WINDOW_BLOCKS ? head - WINDOW_BLOCKS : 0n;
  const read = (event: string) => call<{ data: EventRow[] }>(`/v1/events?${new URLSearchParams({
    standard: "market", event, receiver: config.marketId, fromBlock: from.toString(), limit: "100",
  })}`).then((reply) => reply.body.data);
  const rows = (await Promise.all([read("buy"), read("sell")])).flat();
  return rows.map(parse).filter((t): t is Trade => t !== null && (!marketId || t.marketId === marketId))
    .sort((a, b) => b.at - a.at).slice(0, limit);
}
