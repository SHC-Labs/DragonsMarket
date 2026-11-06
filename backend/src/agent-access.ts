import { randomBytes, randomUUID } from 'node:crypto';
import { object } from './ingestion/block.js';
import { signedBy, tokenHash } from './auth.js';
import { transaction } from './database.js';
import { agentLock } from './locks.js';
import { ReadError } from './read-api.js';
import { isUint, isUnits } from './validate.js';
import { ACCESS_KINDS, parseAgentAction } from './agent-actions.js';
import {
  activeAgent, agentOperations, authorizedUntil, claimableStakes, marketPositions, ownedAgent, parseOwnedAction,
  runOwnedAction, type AgentAccounts,
} from './agent-accounts.js';
import type { Owner } from './agent-paths.js';
import { spentToday } from './operations.js';

export interface Access {
  tokenId: string; label: string; agentId: string; agentAccount: string; nearAccount: string; owner: string;
  frozen: boolean; maxSpend: bigint; dailyLimit: bigint; expiresAt: Date;
}

const LIFETIME_MS = 30 * 24 * 3600 * 1000;
const SIGNING_MS = 5 * 60 * 1000;
const LIVE_TOKENS = 5;
const BEARER = /^Bearer (dmk_[A-Za-z0-9_-]{43})$/;
const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const MAX_SERIES = 12;
const MARKET_WINDOW = 50n;

function limit(value: unknown, what: string) {
  if (!isUnits(value) || value === '0') throw new ReadError(400, `invalid_${what}`);
  return BigInt(value);
}

function decimal(units: bigint, decimals: number) {
  const text = units.toString().padStart(decimals + 1, '0'), cut = text.length - decimals;
  const fraction = text.slice(cut).replace(/0+$/, '');
  return fraction ? `${text.slice(0, cut)}.${fraction}` : text.slice(0, cut);
}

interface AccessTerms { owner: string; agentId: string; label: string; maxSpend: bigint; dailyLimit: bigint }

function accessMessage(s: AgentAccounts, terms: AccessTerms) {
  const { collateralTokenId: token, collateralDecimals: decimals } = s.deployment;
  return ['Give an AI agent access to a Dragons Market agent account', `Account: ${terms.owner}`,
    `Agent: ${terms.agentId}`, `Name: ${terms.label}`,
    `Most for one stake or buy: ${decimal(terms.maxSpend, decimals)} ${token}`,
    `Most in 24 hours: ${decimal(terms.dailyLimit, decimals)} ${token}`,
    'These limits cover stakes and buys. It can also sell what the agent holds, and pay out to this account only.',
    'This access lasts 30 days.'].join('\n');
}

export async function requestAccess(s: AgentAccounts, owner: Owner, agentId: string, body: Record<string, unknown>) {
  if (typeof body.label !== 'string' || !LABEL.test(body.label)) throw new ReadError(400, 'invalid_label');
  const label = body.label, maxSpend = limit(body.max_spend, 'max_spend');
  const dailyLimit = limit(body.daily_limit, 'daily_limit');
  if (dailyLimit < maxSpend) throw new ReadError(400, 'daily_limit_below_max_spend');
  const agent = await activeAgent(s, owner, agentId);
  const id = randomUUID(), nonce = randomBytes(32).toString('base64');
  const message = accessMessage(s, { owner: owner.account, agentId, label, maxSpend, dailyLimit });
  await transaction(s.db, async c => {
    await agentLock(c, `access:${agent.id}`);
    const { rows: [live] } = await c.query(`SELECT count(*)::int AS n FROM agent_access_tokens
      WHERE agent_account=$1 AND revoked_at IS NULL AND expires_at>now()`, [agent.id]);
    if (live.n >= LIVE_TOKENS) throw new ReadError(409, 'access_token_limit_reached');
    await c.query(`INSERT INTO agent_access_tokens(id,agent_account,label,max_spend,daily_limit,message,nonce,
      expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, agent.id, label, String(maxSpend), String(dailyLimit), message,
      nonce, new Date(Date.now() + SIGNING_MS)]);
  });
  return { id, message, nonce, recipient: s.webOrigin };
}

function verified(s: AgentAccounts, signed: { publicKey: unknown; signature: unknown }, asked: {
  message: string; nonce: string;
}) {
  const { publicKey, signature } = signed;
  if (typeof publicKey !== 'string' || typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
  try {
    return signedBy(publicKey, signature, { ...asked, recipient: s.webOrigin });
  } catch { return false; }
}

export async function signAccess(s: AgentAccounts, owner: Owner, agentId: string, tokenId: string,
  body: Record<string, unknown>) {
  const agent = await activeAgent(s, owner, agentId);
  const { rows: [asked] } = await s.db.query(`SELECT label,max_spend,daily_limit,message,nonce FROM agent_access_tokens
    WHERE id=$1 AND agent_account=$2 AND token_hash IS NULL AND revoked_at IS NULL AND expires_at>now()`,
  [tokenId, agent.id]);
  if (!asked) throw new ReadError(404, 'access_request_not_found');
  const signed = { publicKey: body.public_key, signature: body.signature };
  if (!verified(s, signed, asked) || !(await s.checkKey(owner.account, signed.publicKey as string))) {
    throw new ReadError(403, 'invalid_signature');
  }
  const token = `dmk_${randomBytes(32).toString('base64url')}`, expiresAt = new Date(Date.now() + LIFETIME_MS);
  const { rowCount } = await s.db.query(`UPDATE agent_access_tokens SET token_hash=$2,expires_at=$3
    WHERE id=$1 AND token_hash IS NULL AND revoked_at IS NULL AND expires_at>now()`,
  [tokenId, tokenHash(token), expiresAt]);
  if (rowCount !== 1) throw new ReadError(404, 'access_request_not_found');
  return { id: tokenId, token, label: asked.label, max_spend: asked.max_spend, daily_limit: asked.daily_limit,
    expires_at: expiresAt.toISOString() };
}

export async function listAccessTokens(s: AgentAccounts, owner: Owner, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  const { rows } = await s.db.query(`SELECT id,label,max_spend,daily_limit,expires_at,last_used_at,created_at
    FROM agent_access_tokens WHERE agent_account=$1 AND token_hash IS NOT NULL AND revoked_at IS NULL
    AND expires_at>now() ORDER BY created_at DESC`, [agent.id]);
  return { data: rows };
}

export async function revokeAccessToken(s: AgentAccounts, owner: Owner, agentId: string, tokenId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  const { rowCount } = await s.db.query(`UPDATE agent_access_tokens SET revoked_at=now()
    WHERE id=$1 AND agent_account=$2 AND revoked_at IS NULL`, [tokenId, agent.id]);
  if (rowCount !== 1) throw new ReadError(404, 'access_token_not_found');
  return { revoked: true };
}

export async function accessFor(s: AgentAccounts, authorization: string | undefined): Promise<Access> {
  const token = BEARER.exec(authorization ?? '')?.[1];
  if (!token) throw new ReadError(401, 'access_token_required');
  const { rows: [row] } = await s.db.query(`SELECT t.id,t.label,t.max_spend,t.daily_limit,t.expires_at,
    t.last_used_at>now()-interval '1 minute' AS fresh,a.id AS agent_account,a.agent_id,a.near_account_id,
    a.owner_account_id,a.frozen FROM agent_access_tokens t JOIN agent_accounts a ON a.id=t.agent_account
    WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND a.deployment_id=$2
    AND a.state='active'`, [tokenHash(token), s.deployment.id]);
  if (!row) throw new ReadError(401, 'access_token_invalid');
  if (!row.fresh) await s.db.query('UPDATE agent_access_tokens SET last_used_at=now() WHERE id=$1', [row.id]);
  return { tokenId: row.id, label: row.label, agentId: row.agent_id, agentAccount: row.agent_account,
    nearAccount: row.near_account_id, owner: row.owner_account_id, frozen: row.frozen,
    maxSpend: BigInt(row.max_spend), dailyLimit: BigInt(row.daily_limit), expiresAt: row.expires_at };
}

export function runAccessAction(s: AgentAccounts, access: Access, body: Record<string, unknown>) {
  if (typeof body.request_id !== 'string' || !REQUEST_ID.test(body.request_id)) {
    throw new ReadError(400, 'invalid_request_id');
  }
  return runOwnedAction(s, { account: access.owner }, access.agentId, { key: `mcp-${body.request_id}`,
    action: parseOwnedAction(body.action, access.owner, ACCESS_KINDS),
    limits: { via: access.tokenId, one: access.maxSpend, daily: access.dailyLimit } });
}

export const accessSession = (s: AgentAccounts, access: Access) => ({
  agent_id: access.agentId, label: access.label, expires_at: access.expiresAt,
  collateral: { token_id: s.deployment.collateralTokenId, decimals: s.deployment.collateralDecimals },
});

const digits = (value: unknown) => (isUnits(value) ? value : null);
const moment = (ns: unknown) => (isUint(ns) ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);
const roundsOf = (s: AgentAccounts) => s.deployment.contracts.rounds ?? (() => {
  throw new ReadError(503, 'rounds_not_configured');
})();
const marketOf = (s: AgentAccounts) => s.deployment.contracts.market ?? (() => {
  throw new ReadError(503, 'market_not_configured');
})();

export async function accessSummary(s: AgentAccounts, access: Access) {
  const { rounds, market, verifier } = s.deployment.contracts, where = { account_id: access.nearAccount };
  const [near, intents, inRounds, inMarket, spent, until] = await Promise.all([
    s.chain.nearBalance(access.nearAccount),
    verifier ? s.chain.view(verifier, 'mt_balance_of', { ...where, token_id: s.deployment.collateralTokenId }) : null,
    rounds ? s.chain.view(rounds, 'get_account', where) : null,
    market ? s.chain.view(market, 'get_account', where) : null,
    spentToday(s.db, s.deployment.id, access.tokenId),
    authorizedUntil(s, { id: access.agentAccount, agent_id: access.agentId }),
  ]);
  const staking = object(inRounds) ? inRounds : {}, trading = object(inMarket) ? inMarket : {};
  return {
    agent_id: access.agentId, near_account_id: access.nearAccount, frozen: access.frozen, authorized_until: until,
    collateral: { token_id: s.deployment.collateralTokenId, decimals: s.deployment.collateralDecimals },
    balances: { near_for_gas: digits(near), intents: digits(intents), rounds_available: digits(staking.available),
      rounds_pending_withdrawals: digits(staking.pending_withdrawals),
      registered_with_rounds: staking.registered === true,
      open_stakes: Number.isSafeInteger(staking.open_stakes) ? staking.open_stakes : null,
      market_available: digits(trading.available), market_pending_withdrawals: digits(trading.pending_withdrawals),
      registered_with_market: trading.registered === true,
      positions: Number.isSafeInteger(trading.positions) ? trading.positions : null },
    limits: { max_spend: String(access.maxSpend), daily_limit: String(access.dailyLimit),
      spent_today: String(spent), expires_at: access.expiresAt },
  };
}

function openRound(entry: unknown, nowNs: bigint) {
  if (!object(entry) || !isUint(entry.opens_at) || !isUint(entry.closes_at)) throw new Error('invalid_open_round');
  return { series: entry.series_id, asset: typeof entry.asset === 'string' ? entry.asset : null,
    round: digits(entry.round), opens_at: moment(entry.opens_at), closes_at: moment(entry.closes_at),
    taking_stakes: nowNs >= BigInt(entry.opens_at) && nowNs < BigInt(entry.closes_at) };
}

export async function accessRounds(s: AgentAccounts) {
  const rounds = roundsOf(s);
  const [config, open] = await Promise.all([s.chain.view(rounds, 'config', {}),
    s.chain.view(rounds, 'open_rounds', { from_index: 0, limit: MAX_SERIES })]);
  if (!object(config) || !Array.isArray(open)) throw new Error('invalid_rounds_config');
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  return { rules: { min_stake: digits(config.min_stake), paused: config.paused === true,
    max_open_stakes: Number.isSafeInteger(config.max_open_stakes) ? config.max_open_stakes : null },
  series: open.map(entry => openRound(entry, nowNs)) };
}

export async function accessQuote(s: AgentAccounts, body: Record<string, unknown>) {
  const asked = parseAgentAction({ ...body, kind: 'stake', minShares: '0' }, ['stake']);
  if (asked.kind !== 'stake') throw new ReadError(400, 'invalid_action');
  const shares = await s.chain.view(roundsOf(s), 'quote_stake',
    { series_id: asked.series, round: asked.round, side: asked.side, amount: asked.amount });
  if (digits(shares) === null) throw new Error('invalid_quote');
  return { series: asked.series, round: asked.round, side: asked.side, amount: asked.amount, shares };
}

function listedMarket(entry: unknown) {
  if (!object(entry) || !isUint(entry.id) || !isUint(entry.close_at)) throw new Error('invalid_market');
  return { market: entry.id, title: entry.title, rule: entry.rule_text, resolution_source: entry.resolution_source,
    category: entry.category, closes_at: moment(entry.close_at), price_yes: digits(entry.price_yes),
    price_no: digits(entry.price_no), locked: digits(entry.locked) };
}

export async function accessMarkets(s: AgentAccounts) {
  const market = marketOf(s), config = await s.chain.view(market, 'config', {});
  if (!object(config) || !isUint(config.markets)) throw new Error('invalid_market_config');
  const total = BigInt(config.markets), from = total > MARKET_WINDOW ? total - MARKET_WINDOW : 0n;
  const listed = await s.chain.view(market, 'list_markets', { from_index: String(from), limit: String(MARKET_WINDOW) });
  if (!Array.isArray(listed)) throw new Error('invalid_market_list');
  return { rules: { fee_rate_bps: config.fee_rate_bps, paused: config.paused === true,
    sells_paused: config.sells_paused === true,
    max_positions: Number.isSafeInteger(config.max_positions) ? config.max_positions : null },
  markets: listed.filter(entry => object(entry) && entry.status === 'open').map(listedMarket) };
}

export const accessPositions = (s: AgentAccounts, access: Access) => marketPositions(s, access.nearAccount);

export async function accessQuoteBuy(s: AgentAccounts, body: Record<string, unknown>) {
  const asked = parseAgentAction({ ...body, kind: 'buy', minShares: '1' }, ['buy']);
  if (asked.kind !== 'buy') throw new ReadError(400, 'invalid_action');
  const quote = await s.chain.view(marketOf(s), 'quote_buy',
    { market_id: asked.market, side: asked.side, amount: asked.amount });
  if (!object(quote) || digits(quote.shares_out) === null || digits(quote.fee) === null) throw new Error('invalid_quote');
  return { market: asked.market, side: asked.side, amount: asked.amount, shares: quote.shares_out, fee: quote.fee };
}

export async function accessQuoteSell(s: AgentAccounts, body: Record<string, unknown>) {
  const asked = parseAgentAction({ ...body, kind: 'sell', minCollateral: '1' }, ['sell']);
  if (asked.kind !== 'sell') throw new ReadError(400, 'invalid_action');
  const quote = await s.chain.view(marketOf(s), 'quote_sell',
    { market_id: asked.market, side: asked.side, shares: asked.shares });
  if (!object(quote) || !isUnits(quote.collateral_out) || !isUnits(quote.fee)) throw new Error('invalid_quote');
  return { market: asked.market, side: asked.side, shares: asked.shares, fee: quote.fee,
    collateral: String(BigInt(quote.collateral_out) - BigInt(quote.fee)) };
}

export const accessOperations = (s: AgentAccounts, access: Access) =>
  agentOperations(s, { account: access.owner }, access.agentId);

export const accessClaimable = (s: AgentAccounts, access: Access) => claimableStakes(s, access.nearAccount);
