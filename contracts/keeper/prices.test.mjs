import test from "node:test";
import assert from "node:assert/strict";
import { atDecimals, closesAt, lastClose, median, minuteOf, pairIn, priceAt, toScaled, VENUES } from "./prices.mjs";

const MINUTE = 1_793_135_160;
const OBSERVATION_NS = BigInt(MINUTE + 25) * 1_000_000_000n;
const scaled = (text) => toScaled(text);

function exchanges({ coinbase = 80646.07, kraken = "80652.6", bitstamp = "80653.19", down = [] } = {}) {
  const bodies = {
    coinbase: [[MINUTE, 80646.07, 80659.68, 80646.08, 80656.4, 2.4], [MINUTE - 60, 80633.02, 80652.03, 80649.01, coinbase, 4.9]],
    kraken: { error: [], result: { XXBTZUSD: [[MINUTE - 120, "80679.8", "80679.8", "80649.1", "80649.1", "80663.2", "0.8", 78], [MINUTE - 60, "80649.1", "80652.6", "80647.6", kraken, "80649.1", "1.8", 55], [MINUTE, "80652.6", "80659.8", "80649.4", "80656.8", "80654.2", "0.2", 9]], last: MINUTE } },
    bitstamp: { data: { pair: "BTC/USD", ohlc: [{ timestamp: String(MINUTE - 60), open: "80648.80", high: "80654.59", low: "80648.80", close: bitstamp, volume: "0.29" }, { timestamp: String(MINUTE), open: "80653.19", high: "80660.23", low: "80653.19", close: "80660.00", volume: "0.1" }] } },
  };
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const venue = Object.keys(VENUES).find((v) => url.startsWith(VENUES[v]));
    if (down.includes(venue)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => bodies[venue] };
  };
  return { fetch, seen };
}

test("a resolution source names exactly one priced pair, and anything else is refused", () => {
  assert.equal(pairIn("Median of BTC-USD one minute closes on Coinbase, Kraken and Bitstamp"), "BTC-USD");
  assert.equal(pairIn("NEAR-USD at noon, NEAR-USD again"), "NEAR-USD");
  assert.throws(() => pairIn("Median of the 1 minute closing prices on three major exchanges"), /names 0/);
  assert.throws(() => pairIn("BTC-USD against ETH-USD"), /names 2/);
  assert.throws(() => pairIn("BTC-USDT on Binance"), /names 0/);
  assert.throws(() => pairIn("SOL-USD"), /SOL-USD is not a pair the publisher prices/);
});

test("decimal text becomes a 12 digit fixed point integer, and anything that is not a plain positive decimal is refused", () => {
  assert.equal(toScaled("80652.6"), 80_652_600_000_000_000n);
  assert.equal(toScaled(4.6206), 4_620_600_000_000n);
  assert.equal(toScaled("0.1234567890129"), 123_456_789_012n);
  for (const bad of ["", "-1", "1e-7", "1,000.5", "0", "0.000"]) assert.equal(toScaled(bad), null, bad);
  assert.equal(toScaled(1e-7), null);
});

test("a price goes to the market's decimals rounding half up, and past 12 decimals it is scaled up", () => {
  assert.equal(atDecimals(toScaled("105.005"), 2), 10_501n);
  assert.equal(atDecimals(toScaled("105.0049"), 2), 10_500n);
  assert.equal(atDecimals(toScaled("80652.6"), 0), 80_653n);
  assert.equal(atDecimals(toScaled("1.5"), 18), 1_500_000_000_000_000_000n);
});

test("the observation minute is the minute the observation time falls in", () => {
  assert.equal(minuteOf(OBSERVATION_NS), MINUTE);
  assert.equal(minuteOf(BigInt(MINUTE) * 1_000_000_000n), MINUTE);
  assert.equal(minuteOf(BigInt(MINUTE) * 1_000_000_000n - 1n), MINUTE - 60);
});

test("the close used is the last traded minute that ended by the observation minute, within five minutes", () => {
  const candles = [
    { start: MINUTE - 360, close: "1", traded: true },
    { start: MINUTE - 180, close: "2", traded: true },
    { start: MINUTE - 120, close: "3", traded: true },
    { start: MINUTE - 60, close: "4", traded: false },
    { start: MINUTE, close: "5", traded: true },
  ];
  assert.equal(lastClose(candles, MINUTE), scaled("3"), "an untraded minute and the observation minute itself are skipped");
  assert.equal(lastClose(candles.slice(0, 1), MINUTE), null, "a trade over five minutes old is stale");
  assert.equal(lastClose([], MINUTE), null);
});

test("three closes give the middle one, two give their mean, fewer is refused, and a wide spread is refused", () => {
  assert.deepEqual(median({ a: scaled("101"), b: scaled("100"), c: scaled("100.5") }), { scaled: scaled("100.5"), sources: 3 });
  assert.deepEqual(median({ a: scaled("100"), b: null, c: scaled("100.5") }), { scaled: scaled("100.25"), sources: 2 });
  assert.throws(() => median({ a: scaled("100"), b: null, c: null }), /only 1 of 3 exchanges traded/);
  assert.throws(() => median({ a: scaled("100"), b: scaled("101.1"), c: scaled("100.5") }), /more than 100 bps apart/);
  assert.equal(median({ a: scaled("100"), b: scaled("101.005"), c: scaled("100.5") }).sources, 3, "exactly 100 bps is still agreement");
});

test("each exchange is read in its own format at the minute before the observation", async () => {
  const { fetch, seen } = exchanges();
  const closes = await closesAt({ pair: "BTC-USD", minute: MINUTE, fetch });
  assert.deepEqual(closes, { coinbase: scaled("80646.07"), kraken: scaled("80652.6"), bitstamp: scaled("80653.19") });
  assert.deepEqual(seen, [
    "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-10-27T21:01:00Z&end=2026-10-27T21:06:00Z",
    `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${MINUTE - 300}`,
    `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=6&start=${MINUTE - 300}`,
  ]);
});

test("an exchange that fails counts as missing, and the price comes from the others at the market's decimals", async () => {
  const { fetch } = exchanges({ down: ["kraken"] });
  const priced = await priceAt({ pair: "BTC-USD", observationNs: OBSERVATION_NS, decimals: 2, fetch });
  assert.deepEqual(priced, { price: 8_064_963n, sources: 2, venues: 3 });
  const all = await priceAt({ pair: "BTC-USD", observationNs: OBSERVATION_NS, decimals: 2, fetch: exchanges().fetch });
  assert.deepEqual(all, { price: 8_065_260n, sources: 3, venues: 3 });
  await assert.rejects(priceAt({ pair: "BTC-USD", observationNs: OBSERVATION_NS, decimals: 2, fetch: exchanges({ down: ["kraken", "bitstamp"] }).fetch }), /only 1 of 3/);
});
