import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { object } from './ingestion/block.js';
import { transaction } from './database.js';
import { LOCK } from './locks.js';
import { ReadError } from './read-api.js';
import { parseAgentAction, type AgentAction } from './agents.js';
import {
  activeAgent, agentOperations, authorizedUntil, ownedAgent, runOwnedAction, type AgentAccounts, type Owner,
} from './agent-accounts.js';

export interface Access {
  tokenId: string; label: string; agentId: string; agentAccount: string; nearAccount: string; owner: string;
  maxStake: bigint; dailyLimit: bigint; expiresAt: Date;
}

const LIFETIME_MS = 30 * 24 * 3600 * 1000;
const LIVE_TOKENS = 5;
const BEARER = /^Bearer (dmk_[A-Za-z0-9_-]{43})$/;
const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
const UNITS = /^[1-9]\d{0,38}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SERIES = 12;

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function units(value: unknown, what: string) {
  if (typeof value !== 'string' || !UNITS.test(value) || BigInt(value) >= 2n ** 128n) {
    throw new ReadError(400, `invalid_${what}`);
  }
  return BigInt(value);
}

export async function createAccessToken(s: AgentAccounts, owner: Owner, agentId: string, body: Record<string, unknown>) {
  if (typeof body.label !== 'string' || !LABEL.test(body.label)) throw new ReadError(400, 'invalid_label');
  const label = body.label, maxStake = units(body.max_stake, 'max_stake');
  const dailyLimit = units(body.daily_limit, 'daily_limit');
  if (dailyLimit < maxStake) throw new ReadError(400, 'daily_limit_below_max_stake');
  const agent = await activeAgent(s, owner, agentId);
  const token = `dmk_${randomBytes(32).toString('base64url')}`, id = randomUUID();
  const expiresAt = new Date(Date.now() + LIFETIME_MS);
  await transaction(s.db, async c => {
    await c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [`access:${agent.id}`]);
    const { rows: [live] } = await c.query(`SELECT count(*)::int AS n FROM agent_access_tokens
      WHERE agent_account=$1 AND revoked_at IS NULL AND expires_at>now()`, [agent.id]);
    if (live.n >= LIVE_TOKENS) throw new ReadError(409, 'access_token_limit_reached');
    await c.query(`INSERT INTO agent_access_tokens(id,agent_account,token_hash,label,max_stake,daily_limit,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, agent.id, tokenHash(token), label, String(maxStake), String(dailyLimit), expiresAt]);
  });
  return { id, token, label, max_stake: String(maxStake), daily_limit: String(dailyLimit),
    expires_at: expiresAt.toISOString() };
}

export async function listAccessTokens(s: AgentAccounts, owner: Owner, agentId: string) {
  const agent = await ownedAgent(s, owner, agentId);
  const { rows } = await s.db.query(`SELECT id,label,max_stake,daily_limit,expires_at,last_used_at,created_at
    FROM agent_access_tokens WHERE agent_account=$1 AND revoked_at IS NULL AND expires_at>now()
    ORDER BY created_at DESC`, [agent.id]);
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
  const { rows: [row] } = await s.db.query(`SELECT t.id,t.label,t.max_stake,t.daily_limit,t.expires_at,
    t.last_used_at>now()-interval '1 minute' AS fresh,a.id AS agent_account,a.agent_id,a.near_account_id,
    a.owner_account_id FROM agent_access_tokens t JOIN agent_accounts a ON a.id=t.agent_account
    WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND a.deployment_id=$2
    AND a.state='active'`, [tokenHash(token), s.deployment.id]);
  if (!row) throw new ReadError(401, 'access_token_invalid');
  if (!row.fresh) await s.db.query('UPDATE agent_access_tokens SET last_used_at=now() WHERE id=$1', [row.id]);
  return { tokenId: row.id, label: row.label, agentId: row.agent_id, agentAccount: row.agent_account,
    nearAccount: row.near_account_id, owner: row.owner_account_id, maxStake: BigInt(row.max_stake),
    dailyLimit: BigInt(row.daily_limit), expiresAt: row.expires_at };
}

const stakedToday = (s: AgentAccounts, tokenId: string) => s.db.query(`SELECT COALESCE(sum(amount),0)::text AS n
  FROM agent_access_stakes WHERE token=$1 AND created_at>now()-interval '1 day'`, [tokenId]).then(r => r.rows[0].n);

function admitStake(s: AgentAccounts, access: Access, key: string) {
  return async (action: AgentAction) => {
    if (action.kind !== 'stake') return;
    const amount = BigInt(action.amount);
    if (amount > access.maxStake) throw new ReadError(409, 'stake_over_limit');
    await transaction(s.db, async c => {
      await c.query(`SELECT pg_advisory_xact_lock(${LOCK.agents},hashtext($1))`, [`stakes:${access.tokenId}`]);
      const { rows: [held] } = await c.query(`SELECT (SELECT amount::text FROM agent_access_stakes
        WHERE token=$1 AND idempotency_key=$2) AS admitted, (SELECT COALESCE(sum(amount),0)::text
        FROM agent_access_stakes WHERE token=$1 AND created_at>now()-interval '1 day') AS today`,
      [access.tokenId, key]);
      if (held.admitted !== null) {
        if (held.admitted !== String(amount)) throw new ReadError(409, 'operation_idempotency_conflict');
        return;
      }
      if (BigInt(held.today) + amount > access.dailyLimit) throw new ReadError(409, 'daily_limit_reached');
      await c.query('INSERT INTO agent_access_stakes(token,idempotency_key,amount) VALUES($1,$2,$3)',
        [access.tokenId, key, String(amount)]);
    });
  };
}

export function runAccessAction(s: AgentAccounts, access: Access, body: Record<string, unknown>) {
  if (typeof body.request_id !== 'string' || !REQUEST_ID.test(body.request_id)) {
    return Promise.reject(new ReadError(400, 'invalid_request_id'));
  }
  const key = `mcp-${body.request_id}`;
  return runOwnedAction(s, { account: access.owner }, access.agentId,
    { key, action: body.action, via: access.tokenId, admit: admitStake(s, access, key) });
}

export const accessSession = (s: AgentAccounts, access: Access) => ({
  agent_id: access.agentId, label: access.label, expires_at: access.expiresAt,
  collateral: { token_id: s.deployment.collateralTokenId, decimals: s.deployment.collateralDecimals },
});

const integer = (value: unknown) => (typeof value === 'string' && /^\d{1,39}$/.test(value) ? value : null);
const roundsOf = (s: AgentAccounts) => s.deployment.contracts.rounds ?? (() => {
  throw new ReadError(503, 'rounds_not_configured');
})();

export async function accessSummary(s: AgentAccounts, access: Access) {
  const rounds = roundsOf(s), verifier = s.deployment.contracts.verifier;
  const agent = await activeAgent(s, { account: access.owner }, access.agentId);
  const [near, intents, held, staked, until] = await Promise.all([
    s.chain.nearBalance(access.nearAccount),
    verifier ? s.runner.view(verifier, 'mt_balance_of',
      { account_id: access.nearAccount, token_id: s.deployment.collateralTokenId }) : null,
    s.runner.view(rounds, 'get_account', { account_id: access.nearAccount }),
    stakedToday(s, access.tokenId),
    authorizedUntil(s, agent),
  ]);
  const account = object(held) ? held : {};
  return {
    agent_id: access.agentId, near_account_id: access.nearAccount, frozen: agent.frozen, authorized_until: until,
    collateral: { token_id: s.deployment.collateralTokenId, decimals: s.deployment.collateralDecimals },
    balances: { near_for_gas: integer(near), rounds_available: integer(account.available),
      rounds_pending_withdrawals: integer(account.pending_withdrawals), intents: integer(intents),
      registered_with_rounds: account.registered === true,
      open_stakes: Number.isSafeInteger(account.open_stakes) ? account.open_stakes : null },
    limits: { max_stake: String(access.maxStake), daily_limit: String(access.dailyLimit), staked_today: staked,
      expires_at: access.expiresAt },
  };
}

export async function accessRounds(s: AgentAccounts) {
  const rounds = roundsOf(s);
  const config = await s.runner.view(rounds, 'config', {});
  if (!object(config) || !Number.isSafeInteger(config.series)) throw new Error('invalid_rounds_config');
  const ids = Array.from({ length: Math.min(config.series as number, MAX_SERIES) }, (_, i) => i);
  const series = await Promise.all(ids.map(async id => {
    const [found, next] = await Promise.all([s.runner.view(rounds, 'get_series', { series_id: id }),
      s.runner.view(rounds, 'next_round', { series_id: id })]);
    return { series: id, asset: object(found) && typeof found.asset === 'string' ? found.asset : null,
      next_round: integer(next) };
  }));
  return { rules: { min_stake: integer(config.min_stake), paused: config.paused === true,
    max_open_stakes: Number.isSafeInteger(config.max_open_stakes) ? config.max_open_stakes : null }, series };
}

export async function accessQuote(s: AgentAccounts, body: Record<string, unknown>) {
  const asked = parseAgentAction({ ...body, kind: 'stake', minShares: '0' }, ['stake']);
  if (asked.kind !== 'stake') throw new ReadError(400, 'invalid_action');
  const shares = await s.runner.view(roundsOf(s), 'quote_stake',
    { series_id: asked.series, round: asked.round, side: asked.side, amount: asked.amount });
  if (integer(shares) === null) throw new Error('invalid_quote');
  return { series: asked.series, round: asked.round, side: asked.side, amount: asked.amount, shares };
}

export const accessOperations = (s: AgentAccounts, access: Access) =>
  agentOperations(s, { account: access.owner }, access.agentId);
