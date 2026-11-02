import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidate, type Observation } from '../src/prices.js';

interface Vector {
  name: string;
  closes: string[];
  decimals: number;
  price: string;
}
const vectors: Vector[] = JSON.parse(await readFile(new URL('../../test/fixtures/price-vectors.json', import.meta.url), 'utf8'));
const keeper = await import(new URL('../../../contracts/keeper/prices.mjs', import.meta.url).href);

const BOUNDARY = '1700000100000000000';
const SOURCES = ['coinbase', 'kraken', 'bitstamp'] as const;
const observations = (closes: string[]): Observation[] =>
  closes.map((price, i) => ({
    asset: 'BTC',
    source: SOURCES[i]!,
    quote: 'USD',
    boundaryNs: BOUNDARY,
    sourceTimeNs: BOUNDARY,
    retrievedAt: '2023-11-14T22:15:00.000Z',
    price,
    exactBoundary: true,
    raw: '{}',
  }));

for (const v of vectors) {
  test(`backend price: ${v.name}`, () => {
    const policy = { asset: 'BTC' as const, quote: 'USD' as const, boundaryNs: BOUNDARY, decimals: v.decimals, minimumSources: 2, maxDeviationBps: 100 };
    assert.equal(candidate(observations(v.closes), policy), v.price);
  });
  test(`keeper price: ${v.name}`, () => {
    const closes = Object.fromEntries(v.closes.map((c, i) => [SOURCES[i], keeper.toScaled(c)]));
    assert.equal(keeper.atDecimals(keeper.median(closes).scaled, v.decimals).toString(), v.price);
  });
}
