import { binanceBoundary, coingeckoLatest, decimal, usdBoundary, type Exchange } from './prices.js';
import type { ReadRpcClient } from './providers.js';
import { object } from './ingestion/block.js';

// Sandbox measurements: withdraw 15.31 TGas, buy 13.37, register 12.30, sell 8.72.
// Keep a separate pricing margin below; new action families must be measured before using this budget.
export const GAS_PER_ACTION = 20n * 10n ** 12n;
// 1.5x covers NEAR and gas price moves across what the relayer is exposed to: a boundary price up to five minutes old, a minute
// of cache and ten minutes of honouring the lowest recent quote, plus the 5% the sources may disagree by.
const MARGIN_NUM = 3n, MARGIN_DEN = 2n;
const YOCTO_PER_NEAR = 10n ** 24n;
const PRICE_SCALE = 10n ** 18n;
// Major venues quote NEAR within a fraction of a percent of each other. 5% apart means a frozen feed, a bad parse or a
// stablecoin off its peg, and such a price is not used. An error under 5% moves the fee by less than the margin.
const MAX_DEVIATION_BPS = 500n;
const CACHE_MS = 60_000;
// The longest a signed payload lives at the relay. A fee quoted inside this window is accepted for all of it.
export const FEE_WINDOW_MS = 10 * 60_000;
const STALE_PRICE_MS = 60 * 60_000;
// The protocol's minimum gas price. An RPC that answers lower is wrong, and believing it would price below cost.
export const MIN_GAS_PRICE = 100_000_000n;
const BOUNDARY_NS = 300_000_000_000n;

const BPS = 10_000n;

// swapCostBps is what converting the collected collateral back into NEAR for gas costs (1Click surcharge, solver spread,
// the withdrawal), kept apart from the margin, which only covers price moves.
export interface FeeSettings { minFee: bigint; maxFee: bigint; decimals: number; swapCostBps?: bigint }
/** NEAR in USD scaled by 1e18, and the gas price in yoctoNEAR per gas unit. */
export interface FeeSources { nearUsd: () => Promise<bigint>; gasPrice: () => Promise<bigint> }
export interface FeeQuote { fee: bigint; validUntil: number }
export interface FeeQuoter { quote(): Promise<FeeQuote>; accepted(): Promise<bigint> }
/** `cost` is what the action costs the relayer at that moment, with no margin. No fee below it is accepted. */
interface Sample { at: number; fee: bigint; cost: bigint }

/** The fee the prices call for is above RELAY_MAX_FEE, so the relay stops instead of relaying at a loss. */
export class FeeAboveCeiling extends Error {}

function collateralUnits(gasPrice: bigint, nearUsd: bigint, { decimals, swapCostBps = 0n }: FeeSettings, marginNum: bigint, marginDen: bigint): bigint {
  const numerator = gasPrice * GAS_PER_ACTION * nearUsd * marginNum * (BPS + swapCostBps) * 10n ** BigInt(decimals);
  const denominator = YOCTO_PER_NEAR * PRICE_SCALE * marginDen * BPS;
  return (numerator + denominator - 1n) / denominator;
}

/** Never below the floor. It can be above the ceiling, and then the quoter refuses to price. */
export function requiredFee(gasPrice: bigint, nearUsd: bigint, settings: FeeSettings): bigint {
  const fee = collateralUnits(gasPrice, nearUsd, settings, MARGIN_NUM, MARGIN_DEN);
  return fee < settings.minFee ? settings.minFee : fee;
}

const actionCost = (gasPrice: bigint, nearUsd: bigint, settings: FeeSettings) => collateralUnits(gasPrice, nearUsd, settings, 1n, 1n);
const median = (sorted: bigint[]) => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2n;
};

/** Drops any source more than 5% from the median, then prices from the rest when at least two of them are a majority. */
export function medianPrice(prices: string[]): bigint {
  if (prices.length < 2) throw new Error('fewer than two price sources answered');
  const scaled = prices.map(price => decimal(price, 18)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const center = median(scaled);
  const agreeing = scaled.filter(p => (p > center ? p - center : center - p) * BPS <= center * MAX_DEVIATION_BPS);
  if (agreeing.length < 2 || agreeing.length * 2 <= scaled.length) throw new Error('price sources disagree');
  return median(agreeing);
}

export function nearUsdFrom(observers: (() => Promise<{ price: string }>)[]): () => Promise<bigint> {
  return async () => {
    const results = await Promise.allSettled(observers.map(observe => observe()));
    return medianPrice(results.flatMap(result => (result.status === 'fulfilled' ? [result.value.price] : [])));
  };
}

/** The same exchanges the round prices come from: the last closed five-minute boundary, and CoinGecko's latest. */
export function exchangeNearUsd(transport: typeof fetch = fetch): () => Promise<bigint> {
  const boundary = () => ((BigInt(Date.now() - 5000) * 1_000_000n / BOUNDARY_NS) * BOUNDARY_NS).toString();
  const exchanges: Exchange[] = ['coinbase', 'kraken', 'bitstamp'];
  return nearUsdFrom([
    () => binanceBoundary('NEAR', boundary(), transport),
    ...exchanges.map(source => () => usdBoundary(source, 'NEAR', boundary(), transport)),
    () => coingeckoLatest('NEAR', boundary(), null, transport),
  ].map(observe => async () => ({ price: (await observe()).price })));
}

/** The highest gas price the providers give, and never below the protocol minimum. */
export function rpcGasPrice(...providers: Pick<ReadRpcClient, 'call'>[]): () => Promise<bigint> {
  return async () => {
    const answers = await Promise.allSettled(providers.map(async provider => {
      const result = await provider.call('gas_price', [null]);
      const price = object(result) ? result.gas_price : null;
      if (typeof price !== 'string' || !/^[1-9]\d{0,30}$/.test(price)) throw new Error('invalid gas price');
      return BigInt(price);
    }));
    const prices = answers.flatMap(answer => (answer.status === 'fulfilled' ? [answer.value] : []));
    if (!prices.length) throw new Error('no provider gave a gas price');
    return prices.reduce((high, price) => (price > high ? price : high), MIN_GAS_PRICE);
  };
}

/**
 * Prices a relayed action at most once a minute. A refresh that fails falls back to the last good fee for an hour, then to the
 * ceiling. Every fee it hands out is kept for the window, and the lowest of them that still covers the current cost is what the
 * relay accepts, so a quote stays good for as long as a payload signed with it can live, unless prices rose past the margin.
 */
export function createFeeQuoter(settings: FeeSettings, sources: FeeSources, now: () => number = Date.now): FeeQuoter {
  let samples: Sample[] = [];
  let lastGood: Sample | null = null;
  let pending: Promise<Sample> | null = null;

  async function refresh(): Promise<Sample> {
    const at = now();
    let sample: Sample;
    try {
      const [usd, gas] = await Promise.all([sources.nearUsd(), sources.gasPrice()]);
      sample = { at, fee: requiredFee(gas, usd, settings), cost: actionCost(gas, usd, settings) };
      lastGood = sample;
    } catch {
      sample = lastGood && at - lastGood.at <= STALE_PRICE_MS ? { ...lastGood, at } : { at, fee: settings.maxFee, cost: lastGood?.cost ?? settings.maxFee };
    }
    samples = [...samples.filter(entry => entry.at > at - FEE_WINDOW_MS), sample];
    return sample;
  }

  async function current(): Promise<Sample> {
    const latest = samples.at(-1);
    if (latest && now() - latest.at < CACHE_MS) return latest;
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }

  async function priced(): Promise<Sample> {
    const latest = await current();
    if (latest.fee > settings.maxFee) throw new FeeAboveCeiling('the prices call for a fee above RELAY_MAX_FEE');
    return latest;
  }

  return {
    async quote() {
      const { at, fee } = await priced();
      return { fee, validUntil: at + FEE_WINDOW_MS };
    },
    async accepted() {
      const latest = await priced();
      const since = now() - FEE_WINDOW_MS;
      return samples.reduce((low, entry) => (entry.at > since && entry.fee >= latest.cost && entry.fee < low ? entry.fee : low), latest.fee);
    },
  };
}
