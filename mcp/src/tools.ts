import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { BackendRefusal, type Backend } from './backend.js';
import { UnitsError, fromUnits, toUnits } from './units.js';

type Json = Record<string, unknown>;
interface Credentials { token: string; decimals: number }

export const INSTRUCTIONS = [
  'Dragons Market lets you stake on price rounds for the one agent account its owner connected to you.',
  'Read the dragons-market://skill resource before your first action.',
  'Call get_agent and list_rounds first, then quote_stake, then stake with the min_shares the quote returned.',
  'Give every new action a new request_id. To retry an action, call it again with the same request_id and the same',
  'arguments. An outcome of settling is not a failure: it may still land, so never resend it under a new request_id.',
  'An outcome of needs_owner means stop: do not retry that action at all, and tell the owner.',
  'Money only ever pays out to the owner. Stay within the stake limits get_agent reports.',
].join(' ');

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).describe(
  'A new id you choose for this one action: 8 to 64 letters, digits, - or _. Reuse it only to retry this same action.');
const Amount = z.string().regex(/^\d{1,30}(\.\d{1,38})?$/)
  .describe('An amount of the collateral token as a decimal, such as 5 or 2.5.');
const Series = z.number().int().min(0).max(2 ** 32 - 1).describe('The series id from list_rounds.');
const Round = z.string().regex(/^(0|[1-9]\d{0,19})$/).describe('The round from list_rounds, as a string.');
const Side = z.enum(['up', 'down']).describe('up if you expect the price to end higher, down if lower.');
const Shares = z.string().regex(/^(0|[1-9]\d{0,38})$/)
  .describe('The fewest shares to accept, exactly as quote_stake returned it in min_shares.');
const Slippage = z.number().int().min(0).max(1000).default(100)
  .describe('How far below the quote, in basis points, the shares may fall. 100 is 1%.');

const HINTS: Record<string, string> = {
  access_token_required: 'No Dragons Market access token was sent. Ask the owner for one.',
  access_token_invalid: 'The access token was revoked or has expired. Ask the owner for a new one.',
  grant_required: 'The owner has not authorized Dragons Market for this agent. Ask the owner to authorize it.',
  agent_not_active: 'The agent account is not open yet.',
  agent_frozen: 'The owner froze this agent. It can still claim, withdraw and cash out, but it cannot stake.',
  stake_over_limit: 'The stake is above the owner\'s limit for one stake. Stake less.',
  daily_limit_reached: 'The owner\'s stake limit for the last 24 hours is used up. Stake less or wait.',
  invalid_request_id: 'request_id must be 8 to 64 letters, digits, - or _.',
  operation_idempotency_conflict: 'This request_id was already used for a different action. Use a new request_id.',
};
const RETRY = 'It may have been sent. Call again with the same request_id and arguments; never use a new one for it.';
const SETTLING = 'It may still land. Call this tool again with the same request_id and arguments until the outcome '
  + 'is done or refused. Never send it under a new request_id.';
const STOPPED = 'Dragons Market could not prove what happened, so it stopped this action for the owner to check. It '
  + 'may have landed. Do not retry it under any request_id, and tell the owner.';

const record = (value: unknown): Json =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {});
const pick = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);

const ok = (value: Json): CallToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

function refusal(error: unknown): CallToolResult {
  if (error instanceof UnitsError) return { isError: true, content: [{ type: 'text', text: error.message }] };
  if (!(error instanceof BackendRefusal)) {
    console.error('A Dragons Market tool call failed unexpectedly');
    return { isError: true, content: [{ type: 'text', text: `unavailable: ${RETRY}` }],
      structuredContent: { error: 'unavailable', retry_same_request_id: true } };
  }
  const retry = error.status >= 500 || error.status === 429 || error.code === 'operation_in_progress';
  const text = `${error.code}: ${pick(HINTS, error.code) ?? (retry ? RETRY : 'Dragons Market refused this request.')}`;
  return { isError: true, content: [{ type: 'text', text }],
    structuredContent: { error: error.code, retry_same_request_id: retry } };
}

function credentials(ctx: ServerContext): Credentials {
  const auth = ctx.http?.authInfo, decimals = auth?.extra?.decimals;
  if (!auth || typeof decimals !== 'number') throw new BackendRefusal(401, 'access_token_required');
  return { token: auth.token, decimals };
}

const OUTCOMES: Record<string, string> = { confirmed: 'done', failed: 'refused', reconcile: 'needs_owner' };
const NEXT: Record<string, string> = { settling: SETTLING, needs_owner: STOPPED };

function settled(answer: Json): CallToolResult {
  const state = String(answer.state), outcome = pick(OUTCOMES, state) ?? 'settling', next = pick(NEXT, outcome);
  return ok({ outcome, state, operation: answer.operation ?? null, evidence: answer.evidence ?? null,
    ...(next ? { next } : {}) });
}

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function left(limit: unknown, used: unknown, decimals: number) {
  return typeof limit === 'string' && typeof used === 'string' && /^\d+$/.test(limit) && /^\d+$/.test(used)
    ? fromUnits(String(BigInt(limit) > BigInt(used) ? BigInt(limit) - BigInt(used) : 0n), decimals) : null;
}

async function agentSummary(backend: Backend, { token, decimals }: Credentials) {
  const agent = await backend.call(token, 'GET', 'agent');
  const balances = record(agent.balances), limits = record(agent.limits);
  return ok({
    agent_id: agent.agent_id, near_account_id: agent.near_account_id, frozen: agent.frozen,
    authorized_until: agent.authorized_until, collateral: record(agent.collateral).token_id,
    balances: { rounds_available: fromUnits(balances.rounds_available, decimals),
      rounds_pending_withdrawals: fromUnits(balances.rounds_pending_withdrawals, decimals),
      intents: fromUnits(balances.intents, decimals), near_for_gas: fromUnits(balances.near_for_gas, 24),
      open_stakes: balances.open_stakes, registered_with_rounds: balances.registered_with_rounds },
    limits: { max_stake: fromUnits(limits.max_stake, decimals), daily_limit: fromUnits(limits.daily_limit, decimals),
      staked_last_24h: fromUnits(limits.staked_today, decimals),
      left_last_24h: left(limits.daily_limit, limits.staked_today, decimals), token_expires_at: limits.expires_at },
  });
}

async function rounds(backend: Backend, { token, decimals }: Credentials) {
  const answer = await backend.call(token, 'GET', 'rounds'), rules = record(answer.rules);
  return ok({ rules: { min_stake: fromUnits(rules.min_stake, decimals), max_open_stakes: rules.max_open_stakes,
    paused: rules.paused }, series: answer.series });
}

interface Quote { series: number; round: string; side: 'up' | 'down'; amount: string; max_slippage_bps: number }

async function quote(backend: Backend, { token, decimals }: Credentials, args: Quote) {
  const amount = toUnits(args.amount, decimals);
  const answer = await backend.call(token, 'POST', 'quote',
    { series: args.series, round: args.round, side: args.side, amount });
  const shares = typeof answer.shares === 'string' ? BigInt(answer.shares) : 0n;
  if (shares === 0n) return refusal(new BackendRefusal(409, 'round_takes_no_stake'));
  const minShares = shares * BigInt(10000 - args.max_slippage_bps) / 10000n;
  return ok({ series: args.series, round: args.round, side: args.side, amount: args.amount,
    shares: String(shares), min_shares: String(minShares) });
}

function act(backend: Backend, { token }: Credentials, requestId: string, action: Json) {
  return backend.call(token, 'POST', 'actions', { request_id: requestId, action }).then(settled);
}

function guarded<A>(work: (credentials: Credentials, args: A) => Promise<CallToolResult>) {
  return (args: A, ctx: ServerContext) => Promise.resolve().then(() => work(credentials(ctx), args)).catch(refusal);
}

function registerTools(server: McpServer, backend: Backend) {
  server.registerTool('get_agent', { title: 'Agent account', annotations: READ, inputSchema: z.object({}),
    description: 'The agent account you act for: its balances, whether it is frozen or authorized, and the owner\'s '
      + 'stake limits with what is left of them in the last 24 hours.' },
  guarded(c => agentSummary(backend, c)));
  server.registerTool('list_rounds', { title: 'Open rounds', annotations: READ, inputSchema: z.object({}),
    description: 'Each price series you can stake in, the round it takes stakes for now, and the rules every stake '
      + 'must meet.' },
  guarded(c => rounds(backend, c)));
  server.registerTool('quote_stake', { title: 'Quote a stake', annotations: READ,
    inputSchema: z.object({ series: Series, round: Round, side: Side, amount: Amount, max_slippage_bps: Slippage }),
    description: 'How many shares a stake would buy now, and the min_shares to pass to stake.' },
  guarded((c, args: Quote) => quote(backend, c, args)));
  server.registerTool('stake', { title: 'Stake', annotations: { ...WRITE, destructiveHint: true },
    inputSchema: z.object({ request_id: RequestId, series: Series, round: Round, side: Side, amount: Amount,
      min_shares: Shares }),
    description: 'Stakes from the agent\'s rounds balance on one side of a round. Quote first and pass its min_shares.' },
  guarded((c, args: { request_id: string; series: number; round: string; side: string; amount: string;
    min_shares: string }) => act(backend, c, args.request_id, { kind: 'stake', series: args.series,
    round: args.round, side: args.side, amount: toUnits(args.amount, c.decimals), minShares: args.min_shares })));
  server.registerTool('claim', { title: 'Claim a round', annotations: WRITE,
    inputSchema: z.object({ request_id: RequestId, series: Series, round: Round }),
    description: 'Settles a stake in a round that has an outcome. Winnings go to the agent\'s rounds balance.' },
  guarded((c, args: { request_id: string; series: number; round: string }) =>
    act(backend, c, args.request_id, { kind: 'claim', series: args.series, round: args.round })));
  server.registerTool('withdraw', { title: 'Withdraw from rounds', annotations: WRITE,
    inputSchema: z.object({ request_id: RequestId, amount: Amount }),
    description: 'Moves money from the agent\'s rounds balance into its NEAR Intents balance.' },
  guarded((c, args: { request_id: string; amount: string }) => act(backend, c, args.request_id,
    { kind: 'withdraw', contract: 'rounds', amount: toUnits(args.amount, c.decimals) })));
  server.registerTool('cash_out', { title: 'Cash out to the owner', annotations: WRITE,
    inputSchema: z.object({ request_id: RequestId, amount: Amount }),
    description: 'Pays money from the agent\'s NEAR Intents balance to the owner\'s wallet, the only place it can go.' },
  guarded((c, args: { request_id: string; amount: string }) => act(backend, c, args.request_id,
    { kind: 'cash_out', amount: toUnits(args.amount, c.decimals) })));
  server.registerTool('list_operations', { title: 'History', annotations: READ, inputSchema: z.object({}),
    description: 'The agent\'s recent actions, newest first, with where each one stands.' },
  guarded(c => backend.call(c.token, 'GET', 'operations').then(answer => ok({ operations: answer.data ?? [] }))));
}

export function buildServer(backend: Backend, skill: string) {
  const server = new McpServer({ name: 'dragons-market', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, backend);
  server.registerResource('skill', 'dragons-market://skill', { title: 'Dragons Market skill', mimeType: 'text/markdown',
    description: 'How to act on Dragons Market safely: the workflow, the rules and what each refusal means.' },
  uri => Promise.resolve({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill }] }));
  server.registerPrompt('trade-rounds', { title: 'Trade rounds on Dragons Market',
    description: 'Loads the Dragons Market skill so the agent follows its workflow.' },
  () => ({ messages: [{ role: 'user', content: { type: 'text', text: skill } }] }));
  return server;
}
