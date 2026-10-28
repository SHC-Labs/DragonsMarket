export const PAIRS = {
  "BTC-USD": { coinbase: "BTC-USD", kraken: "XBTUSD", bitstamp: "btcusd" },
  "ETH-USD": { coinbase: "ETH-USD", kraken: "ETHUSD", bitstamp: "ethusd" },
  "NEAR-USD": { coinbase: "NEAR-USD", kraken: "NEARUSD", bitstamp: "nearusd" },
};

export const VENUES = {
  coinbase: "https://api.exchange.coinbase.com",
  kraken: "https://api.kraken.com",
  bitstamp: "https://www.bitstamp.net",
};

const SCALE_DIGITS = 12n;
const SCALE = 10n ** SCALE_DIGITS;
const MINUTE = 60;
const LOOKBACK_MINUTES = 5;
const MIN_SOURCES = 2;
const MAX_SPREAD_BPS = 100n;
const REQUEST_TIMEOUT_MS = 10_000;

export function pairIn(text) {
  const named = [...new Set(text.match(/\b[A-Z0-9]{2,10}-USD\b/g) ?? [])];
  if (named.length !== 1) throw new Error(`the resolution source must name exactly one pair such as BTC-USD, and names ${named.length}`);
  if (!PAIRS[named[0]]) throw new Error(`${named[0]} is not a pair the publisher prices (${Object.keys(PAIRS).join(", ")})`);
  return named[0];
}

export function toScaled(value) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(typeof value === "number" ? String(value) : value);
  if (!match) return null;
  const fraction = (match[2] ?? "").slice(0, Number(SCALE_DIGITS)).padEnd(Number(SCALE_DIGITS), "0");
  const scaled = BigInt(match[1]) * SCALE + BigInt(fraction);
  return scaled > 0n ? scaled : null;
}

export function atDecimals(scaled, decimals) {
  const digits = BigInt(decimals);
  if (digits >= SCALE_DIGITS) return scaled * 10n ** (digits - SCALE_DIGITS);
  const unit = 10n ** (SCALE_DIGITS - digits);
  return (scaled + unit / 2n) / unit;
}

export function minuteOf(observationNs) {
  return Number(BigInt(observationNs) / 1_000_000_000n / BigInt(MINUTE)) * MINUTE;
}

const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

const VENUE_READS = {
  coinbase: {
    url: (base, symbol, from, to) => `${base}/products/${symbol}/candles?granularity=60&start=${iso(from)}&end=${iso(to)}`,
    candles: (body) => body.map((c) => ({ start: c[0], close: c[4], traded: Number(c[5]) > 0 })),
  },
  kraken: {
    url: (base, symbol, from) => `${base}/0/public/OHLC?pair=${symbol}&interval=1&since=${from}`,
    candles: (body) => {
      if (body.error?.length) throw new Error(body.error.join(", "));
      const rows = body.result[Object.keys(body.result).find((key) => key !== "last")] ?? [];
      return rows.map((c) => ({ start: c[0], close: c[4], traded: c[7] > 0 }));
    },
  },
  bitstamp: {
    url: (base, symbol, from) => `${base}/api/v2/ohlc/${symbol}/?step=60&limit=${LOOKBACK_MINUTES + 1}&start=${from}`,
    candles: (body) => body.data.ohlc.map((c) => ({ start: Number(c.timestamp), close: c.close, traded: Number(c.volume) > 0 })),
  },
};

export function lastClose(candles, minute) {
  const from = minute - LOOKBACK_MINUTES * MINUTE;
  const traded = candles.filter((c) => c.traded && c.start >= from && c.start < minute);
  if (!traded.length) return null;
  return toScaled(traded.reduce((latest, c) => (c.start > latest.start ? c : latest)).close);
}

export async function closesAt({ pair, minute, venues = VENUES, fetch = globalThis.fetch }) {
  const from = minute - LOOKBACK_MINUTES * MINUTE;
  const entries = await Promise.all(Object.entries(VENUE_READS).map(async ([venue, read]) => {
    try {
      const res = await fetch(read.url(venues[venue], PAIRS[pair][venue], from, minute), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "dragons-market-publisher" },
      });
      if (!res.ok) return [venue, null];
      return [venue, lastClose(read.candles(await res.json()), minute)];
    } catch {
      return [venue, null];
    }
  }));
  return Object.fromEntries(entries);
}

export function median(closes) {
  const values = Object.values(closes).filter((v) => v !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (values.length < MIN_SOURCES) {
    throw new Error(`only ${values.length} of ${Object.keys(closes).length} exchanges traded in the ${LOOKBACK_MINUTES} minutes before the observation time`);
  }
  const middle = Math.floor(values.length / 2);
  const mid = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2n;
  const spread = values[values.length - 1] - values[0];
  if (spread * 10_000n > MAX_SPREAD_BPS * mid) throw new Error(`the exchanges are more than ${MAX_SPREAD_BPS} bps apart, so no price is signed`);
  return { scaled: mid, sources: values.length };
}

export async function priceAt({ pair, observationNs, decimals, venues, fetch }) {
  const closes = await closesAt({ pair, minute: minuteOf(observationNs), venues, fetch });
  const { scaled, sources } = median(closes);
  return { price: atDecimals(scaled, decimals), sources, venues: Object.keys(closes).length };
}
