import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { BackendRefusal, type Backend } from './backend.js';
import { UnitsError, fromUnits, toUnits } from './units.js';

type Json = Record<string, unknown>;
interface Credentials { token: string; decimals: number }

export const INSTRUCTIONS = [
  'Dragons Market lets you trade event markets and stake on price rounds for the one agent account its owner',
  'connected to you. Read the dragons-market://skill resource before your first action.',
  'Read get_policy and get_agent before acting. Trade amounts are enforced by Dragons Market, not by the native',
  'call policy at the Agent API. Never bypass this MCP to trade with another credential.',
  'To trade a market call list_markets, following next_from_market even through empty pages, then quote_buy or',
  'quote_sell, then buy or sell with the minimum',
  'the quote returned. Call list_positions to find what you hold and what can be redeemed.',
  'To stake on a round call list_rounds, then quote_stake, then stake with the min_shares the quote returned.',
  'Stake only in a round whose taking_stakes is true, and call list_claimable to find stakes ready to claim.',
  'Give every new action a new request_id. To retry an action, call it again with the same request_id and the same',
  'arguments. An outcome of settling is not a failure: it may still land, so never resend it under a new request_id.',
  'An outcome of needs_owner means stop: do not retry that action at all, and tell the owner.',
  'Money only ever pays out to the owner. Stay within the spending limits get_agent reports.',
].join(' ');

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).describe(
  'A new id you choose for this one action: 8 to 64 letters, digits, - or _. Reuse it only to retry this same action.');
const Amount = z.string().regex(/^\d{1,30}(\.\d{1,38})?$/)
  .describe('An amount of the collateral token as a decimal, such as 5 or 2.5.');
const Series = z.number().int().min(0).max(2 ** 32 - 1).describe('The series id from list_rounds.');
const Round = z.string().regex(/^(0|[1-9]\d{0,19})$/).describe('The round from list_rounds, as a string.');
const Side = z.enum(['up', 'down']).describe('up if you expect the price to end higher, down if lower.');
const Whole = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const Shares = Whole.describe('The fewest shares to accept, exactly as the quote returned it in min_shares.');
const Slippage = z.number().int().min(0).max(1000).default(100)
  .describe('How far below the quote, in basis points, the result may fall. 100 is 1%, and 1000 is the most allowed.');
const MarketId = z.string().regex(/^(0|[1-9]\d{0,19})$/).describe('The market from list_markets, as a string.');
const Answer = z.enum(['yes', 'no']).describe('yes or no, the answer to the market\'s question you are trading.');
const Held = Whole.describe('A number of shares exactly as list_positions reports them.');
const Payment = z.string().regex(/^(0|[1-9]\d{0,38})$/)
  .describe('The least to accept, exactly as quote_sell returned it in min_collateral.');
const From = z.enum(['rounds', 'market']).describe('Which balance to withdraw from.');

const HINTS: Record<string, string> = {
  access_token_required: 'No Dragons Market access token was sent. Ask the owner for one.',
  access_token_invalid: 'The access token was revoked or has expired. Ask the owner for a new one.',
  wallet_frozen: 'The owner froze the agent, so this call sent nothing. Nothing moves until they unfreeze it.',
  grant_required: 'The owner has not authorized Dragons Market for this agent, so this call sent nothing. An action '
    + 'sent earlier under this request_id may still land; list_operations shows it. Ask the owner to authorize it.',
  agent_not_active: 'The agent account is not open yet.',
  spend_over_limit: 'That is above the owner\'s limit for one stake or buy. Spend less.',
  daily_limit_reached: 'The owner\'s spending limit for the last 24 hours is used up. Spend less or wait.',
  slippage_too_wide: 'The minimum you passed is more than 10% worse than the price now, so nothing was sent. Quote '
    + 'again and pass the minimum the new quote returns.',
  market_takes_no_buy: 'The market cannot take that buy. Check list_markets, or try a smaller amount.',
  market_takes_no_sell: 'The market cannot take that sell. Check list_positions for what you hold.',
  invalid_request_id: 'request_id must be 8 to 64 letters, digits, - or _.',
  operation_idempotency_conflict: 'This request_id already names an action, with other arguments or under other '
    + 'access. Read list_operations first: if that action is the one you meant, it is being followed, so do not send '
    + 'it again. Use a new request_id only for a different action.',
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
    balances: { market_available: fromUnits(balances.market_available, decimals),
      market_pending_withdrawals: fromUnits(balances.market_pending_withdrawals, decimals),
      registered_with_market: balances.registered_with_market, positions: balances.positions,
      rounds_available: fromUnits(balances.rounds_available, decimals),
      rounds_pending_withdrawals: fromUnits(balances.rounds_pending_withdrawals, decimals),
      open_stakes: balances.open_stakes, registered_with_rounds: balances.registered_with_rounds,
      intents: fromUnits(balances.intents, decimals), near_for_gas: fromUnits(balances.near_for_gas, 24) },
    limits: { max_spend: fromUnits(limits.max_spend, decimals), daily_limit: fromUnits(limits.daily_limit, decimals),
      spent_last_24h: fromUnits(limits.spent_today, decimals),
      left_last_24h: left(limits.daily_limit, limits.spent_today, decimals), token_expires_at: limits.expires_at },
  });
}

async function rounds(backend: Backend, { token, decimals }: Credentials) {
  const answer = await backend.call(token, 'GET', 'rounds'), rules = record(answer.rules);
  return ok({ rules: { min_stake: fromUnits(rules.min_stake, decimals), max_open_stakes: rules.max_open_stakes,
    paused: rules.paused }, series: answer.series });
}

async function claimable(backend: Backend, { token, decimals }: Credentials) {
  const answer = await backend.call(token, 'GET', 'claimable');
  const stakes = Array.isArray(answer.data) ? answer.data.map(record) : [];
  return ok({ stakes: stakes.map(stake => ({ ...stake, amount: fromUnits(stake.amount, decimals) })) });
}

const withSlippage = (value: bigint, bps: number) => String((value * BigInt(10000 - bps) + 9999n) / 10000n);

interface Quote { series: number; round: string; side: 'up' | 'down'; amount: string; max_slippage_bps: number }

async function quote(backend: Backend, { token, decimals }: Credentials, args: Quote) {
  const amount = toUnits(args.amount, decimals);
  const answer = await backend.call(token, 'POST', 'quote',
    { series: args.series, round: args.round, side: args.side, amount });
  const shares = typeof answer.shares === 'string' ? BigInt(answer.shares) : 0n;
  if (shares === 0n) return refusal(new BackendRefusal(409, 'round_takes_no_stake'));
  return ok({ series: args.series, round: args.round, side: args.side, amount: args.amount,
    shares: String(shares), min_shares: withSlippage(shares, args.max_slippage_bps) });
}

const PRICE_DECIMALS = 6;

async function markets(backend: Backend, { token, decimals }: Credentials, fromMarket?: string) {
  const answer = await backend.call(token, 'POST', 'markets', { from_market: fromMarket ?? '0' });
  const listed = Array.isArray(answer.markets) ? answer.markets.map(record) : [];
  return ok({ rules: answer.rules ?? null, next_from_market: answer.next_from_market ?? null,
    markets: listed.map(market => ({ ...market,
    price_yes: fromUnits(market.price_yes, PRICE_DECIMALS), price_no: fromUnits(market.price_no, PRICE_DECIMALS),
    locked: fromUnits(market.locked, decimals) })) });
}

async function positions(backend: Backend, { token, decimals }: Credentials) {
  const answer = await backend.call(token, 'GET', 'positions');
  const held = Array.isArray(answer.data) ? answer.data.map(record) : [];
  return ok({ positions: held.map(position => ({ ...position,
    redeemable: fromUnits(position.redeemable, decimals) })) });
}

interface BuyQuote { market: string; side: 'yes' | 'no'; amount: string; max_slippage_bps: number }

async function quoteBuy(backend: Backend, { token, decimals }: Credentials, args: BuyQuote) {
  const answer = await backend.call(token, 'POST', 'quote-buy',
    { market: args.market, side: args.side, amount: toUnits(args.amount, decimals) });
  const shares = typeof answer.shares === 'string' ? BigInt(answer.shares) : 0n;
  if (shares === 0n) return refusal(new BackendRefusal(409, 'market_takes_no_buy'));
  return ok({ market: args.market, side: args.side, amount: args.amount, shares: String(shares),
    fee: fromUnits(answer.fee, decimals), min_shares: withSlippage(shares, args.max_slippage_bps) });
}

interface SellQuote { market: string; side: 'yes' | 'no'; shares: string; max_slippage_bps: number }

async function quoteSell(backend: Backend, { token, decimals }: Credentials, args: SellQuote) {
  const answer = await backend.call(token, 'POST', 'quote-sell',
    { market: args.market, side: args.side, shares: args.shares });
  const net = typeof answer.collateral === 'string' ? BigInt(answer.collateral) : 0n;
  if (net === 0n) return refusal(new BackendRefusal(409, 'market_takes_no_sell'));
  return ok({ market: args.market, side: args.side, shares: args.shares, collateral: fromUnits(String(net), decimals),
    fee: fromUnits(answer.fee, decimals), min_collateral: withSlippage(net, args.max_slippage_bps) });
}

function act(backend: Backend, { token }: Credentials, requestId: string, action: Json) {
  return backend.call(token, 'POST', 'actions', { request_id: requestId, action }).then(settled);
}

function guarded<A>(work: (credentials: Credentials, args: A) => Promise<CallToolResult>) {
  return (args: A, ctx: ServerContext) => Promise.resolve().then(() => work(credentials(ctx), args)).catch(refusal);
}

function registerTools(server: McpServer, backend: Backend) {
  server.registerTool('get_policy', { title: 'Account and connection policy', annotations: READ,
    inputSchema: z.object({}), description: 'Reads the account policy from the Agent API and the owner-signed '
      + 'connection limits. Explains which service enforces each rule. Raw token limits use atomic units. '
      + 'Stop if the account policy is unverified, unsynced or frozen. This tool cannot change permissions.' },
  guarded(c => backend.call(c.token, 'GET', 'policy').then(ok)));
  server.registerTool('get_agent', { title: 'Agent account', annotations: READ, inputSchema: z.object({}),
    description: 'The agent account you act for: its balances, whether it is frozen or authorized, and the owner\'s '
      + 'spending limits with what is left of them in the last 24 hours.' },
  guarded(c => agentSummary(backend, c)));
  server.registerTool('list_markets', { title: 'Open markets', annotations: READ,
    inputSchema: z.object({ from_market: MarketId.default('0').describe('Omit for the first page, then pass '
      + 'next_from_market from the previous answer. Continue through empty pages until it is null.') }),
    description: 'Scans up to 50 market ids for open event markets, with rules, closing time and prices. '
      + 'An empty page is not the end when next_from_market is present.' },
  guarded((c, args: { from_market: string }) => markets(backend, c, args.from_market)));
  server.registerTool('list_positions', { title: 'Market positions', annotations: READ, inputSchema: z.object({}),
    description: 'The agent\'s shares in each market, the market\'s status, and what redeem would pay now.' },
  guarded(c => positions(backend, c)));
  server.registerTool('quote_buy', { title: 'Quote a buy', annotations: READ,
    inputSchema: z.object({ market: MarketId, side: Answer, amount: Amount, max_slippage_bps: Slippage }),
    description: 'How many shares a buy would get now, its fee, and the min_shares to pass to buy.' },
  guarded((c, args: BuyQuote) => quoteBuy(backend, c, args)));
  server.registerTool('buy', { title: 'Buy shares', annotations: { ...WRITE, destructiveHint: true },
    inputSchema: z.object({ request_id: RequestId, market: MarketId, side: Answer, amount: Amount, min_shares: Shares }),
    description: 'Buys shares from the agent\'s market balance. Quote first and pass its min_shares.' },
  guarded((c, args: { request_id: string; market: string; side: string; amount: string; min_shares: string }) =>
    act(backend, c, args.request_id, { kind: 'buy', market: args.market, side: args.side,
      amount: toUnits(args.amount, c.decimals), minShares: args.min_shares })));
  server.registerTool('quote_sell', { title: 'Quote a sell', annotations: READ,
    inputSchema: z.object({ market: MarketId, side: Answer, shares: Held, max_slippage_bps: Slippage }),
    description: 'What selling shares would pay now after its fee, and the min_collateral to pass to sell.' },
  guarded((c, args: SellQuote) => quoteSell(backend, c, args)));
  server.registerTool('sell', { title: 'Sell shares', annotations: { ...WRITE, destructiveHint: true },
    inputSchema: z.object({ request_id: RequestId, market: MarketId, side: Answer, shares: Held,
      min_collateral: Payment }),
    description: 'Sells shares before a market closes. The money goes to the agent\'s market balance.' },
  guarded((c, args: { request_id: string; market: string; side: string; shares: string; min_collateral: string }) =>
    act(backend, c, args.request_id, { kind: 'sell', market: args.market, side: args.side, shares: args.shares,
      minCollateral: args.min_collateral })));
  server.registerTool('redeem', { title: 'Redeem a market', annotations: WRITE,
    inputSchema: z.object({ request_id: RequestId, market: MarketId }),
    description: 'Pays out the agent\'s shares in a resolved market into its market balance.' },
  guarded((c, args: { request_id: string; market: string }) =>
    act(backend, c, args.request_id, { kind: 'redeem', market: args.market })));
  server.registerTool('list_rounds', { title: 'Open rounds', annotations: READ, inputSchema: z.object({}),
    description: 'Each price series, its round taking stakes now or next to open, when that round opens and closes, '
      + 'whether it is taking stakes, and the rules every stake must meet.' },
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
    description: 'Settles a stake that list_claimable names. Winnings go to the agent\'s rounds balance.' },
  guarded((c, args: { request_id: string; series: number; round: string }) =>
    act(backend, c, args.request_id, { kind: 'claim', series: args.series, round: args.round })));
  server.registerTool('list_claimable', { title: 'Stakes to claim', annotations: READ, inputSchema: z.object({}),
    description: 'The agent\'s stakes in rounds that have an outcome and can be claimed now.' },
  guarded(c => claimable(backend, c)));
  server.registerTool('withdraw', { title: 'Withdraw a balance', annotations: WRITE,
    inputSchema: z.object({ request_id: RequestId, from: From, amount: Amount }),
    description: 'Moves money from the agent\'s market or rounds balance into its NEAR Intents balance.' },
  guarded((c, args: { request_id: string; from: string; amount: string }) => act(backend, c, args.request_id,
    { kind: 'withdraw', venue: args.from, amount: toUnits(args.amount, c.decimals) })));
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
  server.registerPrompt('trade-dragons-market', { title: 'Trade on Dragons Market',
    description: 'Loads the Dragons Market skill so the agent follows its workflow.' },
  () => ({ messages: [{ role: 'user', content: { type: 'text', text: skill } }] }));
  return server;
}
