// A stand-in for the local dev chain (contracts/tests/tests/dev_chain.rs) for UI work on machines without
// Rust or the NEAR sandbox. Answers the JSON-RPC view calls the site makes with markets drawn from the week's
// news and the same six resolution states, and serves a small stand-in for the backend's agent API.
// It also plays a live market: simulated traders and two agents trade every couple of seconds, so prices,
// charts and the ticker move. `sandbox_send` applies a dev account's buy, sell, redeem or withdraw, which is how
// the site trades on this mock (a real sandbox does not know the method and refuses it).
//   node scripts/mock-chain.mjs   chain on 127.0.0.1:3030 (MOCK_CHAIN_PORT), backend on :3031 (MOCK_BACKEND_PORT)
//   MOCK_QUIET=1                  no simulated trading: prices stay where they start
import http from "node:http";
import { existsSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_CHAIN_PORT ?? 3030);
const BACKEND_PORT = Number(process.env.MOCK_BACKEND_PORT ?? 3031);
const LIVE = process.env.MOCK_QUIET !== "1";
const MARKET = "market.test.near", ORACLE = "oracle.test.near", TOKEN = "ft.test.near", VERIFIER = "intents.test.near";
const COUNCIL = "council.test.near", NFT = "nft.test.near", ROUNDS = "rounds.test.near";
const SEC = 1_000_000_000n, DAY = 86_400n * SEC, USD = 1_000_000n, NEAR = 10n ** 24n;
const now = () => BigInt(Date.now()) * 1_000_000n;
const started = now();
const GENESIS_MS = Date.now() - 1_000_000_000;
const height = (ms = Date.now()) => Math.floor((ms - GENESIS_MS) / 1000);

// title, resolution source, void policy, category, subcategory, days to close (negative: already closed),
// where the Yes price stands, money in the pool (USD).
const SPECS = [
  ["Will the Fed raise rates at its 9 December meeting?", "https://www.federalreserve.gov/newsevents/pressreleases.htm", "The meeting is cancelled or postponed past 31 December.", "economy", "fed", 34, 0.78, 184_200],
  ["Will bitcoin close above 80,000 USD on 4 November?", "Median of the closing prices on three major exchanges", "Fewer than two of the three exchanges publish a closing price.", "crypto", "bitcoin", -0.6, 0.62, 61_450],
  ["Will Fenerbahçe beat Liverpool in the Champions League on 4 November?", "https://www.uefa.com", "The match is postponed and not completed within 3 days.", "sports", "soccer", -0.9, 0.31, 23_870],
  ["Will Brent crude settle above 100 USD on 4 November?", "ICE Futures Europe settlement prices", "ICE does not publish a settlement for the day.", "economy", "oil", -1.2, 0.08, 38_900],
  ["Will the federal arts panel give final approval to the Washington arch on 5 November?", "Commission of Fine Arts meeting record", "The meeting is postponed past 30 November.", "politics", "policy", -0.05, 0.71, 9_640],
  ["Will Democrats win control of the House in the 2026 midterms?", "Associated Press race calls", "Control is not decided by 31 January 2027.", "politics", "congress", -1.4, 0.97, 412_300],
  ["Will Mary Peltola win the Alaska Senate race?", "Alaska Division of Elections certified results", "The result is not certified by 31 December.", "politics", "us-elections", 21, 0.95, 96_800],
  ["Will Pete Hegseth leave as Secretary of Defense by 31 December?", "Official White House or Department of Defense announcement", "None. The market resolves No if he is still in office on 31 December.", "politics", "white-house", 56, 0.55, 131_700],
  ["Will the US-Iran ceasefire hold through 15 November?", "Reuters and Associated Press reporting", "None. A resumed strike by either side resolves No.", "world", "geopolitics", 10, 0.64, 88_150],
  ["Will the US and Iran sign a Strait of Hormuz agreement by 31 December?", "Official statements from either government", "None. No signed agreement by the deadline resolves No.", "world", "geopolitics", 56, 0.35, 47_300],
  ["Will Trump, Xi and Putin meet in a three-way summit in November?", "Official statements from the three governments", "None. No meeting by 30 November resolves No.", "world", "geopolitics", 25, 0.27, 52_600],
  ["Will Gadi Eizenkot be Israel's next prime minister?", "Knesset swearing-in record", "No government is sworn in by 30 June 2027.", "politics", "world-elections", 90, 0.56, 74_900],
  ["Will Marine Le Pen win the 2027 French presidential election?", "French Constitutional Council results", "The election is postponed past 31 December 2027.", "politics", "world-elections", 180, 0.43, 66_200],
  ["Will Jon Ossoff win the 2028 Democratic nomination?", "Democratic National Convention roll call", "The convention is not held by 31 December 2028.", "politics", "us-elections", 640, 0.27, 58_400],
  ["Will bitcoin close above 82,000 USD on Friday?", "Median of the closing prices on three major exchanges", "Fewer than two of the three exchanges publish a closing price.", "crypto", "bitcoin", 2, 0.38, 72_300],
  ["Will bitcoin reach 90,000 USD before 2027?", "Median of the prices on three major exchanges", "Fewer than two of the three exchanges publish a price.", "crypto", "bitcoin", 56, 0.39, 103_500],
  ["Will NEAR Intents pass 40 billion USD in all-time volume by year end?", "The public NEAR Intents dashboard", "The dashboard is unavailable on 31 December.", "crypto", "near", 56, 0.46, 41_800],
  ["Will gold settle above 4,000 USD on Friday?", "COMEX settlement prices", "COMEX does not publish a settlement for the day.", "economy", "stocks", 2, 0.66, 29_100],
  ["Will GTA VI launch on 19 November as scheduled?", "Rockstar Games official channels", "None. A delay announced before the date resolves No.", "tech", "gaming", 14, 0.91, 77_600],
  ["Will Google release Gemini 4 to the public by 31 December?", "https://blog.google", "Google withdraws the announcement before the date.", "tech", "ai", 56, 0.68, 49_200],
  ["Will Gen.G win the 2026 League of Legends World Championship?", "https://lolesports.com", "The final is not played by 31 December.", "tech", "gaming", 4, 0.51, 33_700],
  ["Will the Ravens beat the Jaguars on Thursday night?", "https://www.nfl.com/scores", "The game is postponed and not completed within 3 days.", "sports", "nfl", 0.45, 0.63, 27_900],
  ["Will Max Verstappen win the Las Vegas Grand Prix?", "https://www.formula1.com", "The race is cancelled.", "sports", "f1", 16, 0.31, 21_300],
  ["Will Barcelona win the 2026-27 Champions League?", "https://www.uefa.com", "The final is not played by 30 June 2027.", "sports", "soccer", 205, 0.24, 64_800],
  ["Will the Thunder win the 2027 NBA championship?", "https://www.nba.com", "The Finals are not completed by 30 June 2027.", "sports", "nba", 220, 0.27, 45_600],
  ["Will Tom Cruise be nominated for Best Actor at the 2027 Oscars?", "Academy of Motion Picture Arts and Sciences", "The ceremony is cancelled.", "culture", "awards", 70, 0.22, 12_400],
];

// Seeded random numbers, so every start draws the same charts.
function rng(seed) {
  let s = (seed * 2654435761) % 4294967296;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const clamp = (p) => Math.min(0.985, Math.max(0.015, p));

// A random walk pinned at both ends: from an opening guess to where the price stands now.
function history(index, closeAt, target) {
  const r = rng(index + 7);
  const end = closeAt < now() ? closeAt : now();
  const steps = 90 + Math.floor(r() * 60);
  const start = end - BigInt(12 + Math.floor(r() * 20)) * DAY;
  const from = 0.5 + (r() - 0.5) * 0.3;
  const noise = [0];
  for (let i = 1; i <= steps; i++) noise.push(noise[i - 1] + (r() - 0.5) * 0.07);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, bridge = noise[i] - t * noise[steps];
    const at = start + ((end - start) * BigInt(i)) / BigInt(steps);
    return { at: String(at), price_yes: Math.round(clamp(from + (target - from) * t * t * (3 - 2 * t) + bridge * 0.6) * 1e6) };
  }).map((p, i, all) => (i === all.length - 1 ? { ...p, price_yes: Math.round(target * 1e6) } : p));
}

// The pool is the length of the share vector and the Yes price is yes squared over the pool squared.
function reprice(m, price) {
  m.price_yes = String(Math.round(price * 1e6));
  m.price_no = String(1_000_000 - Math.round(price * 1e6));
  m.yes_shares = String(BigInt(Math.floor(Number(m.locked) * Math.sqrt(price))));
  m.no_shares = String(BigInt(Math.floor(Number(m.locked) * Math.sqrt(1 - price))));
}

const markets = SPECS.map(([title, source, voidPolicy, category, sub, days, target, pool], i) => {
  const closeAt = started + BigInt(Math.round(days * 86_400)) * SEC;
  const m = {
    id: String(i), title,
    rule_text: `Resolves Yes if the answer to "${title}" is yes according to the source below when the market closes. Resolves No otherwise.`,
    resolution_source: source, void_policy: voidPolicy, category, subcategory: sub,
    rule_hash: (BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(64, "0").slice(-64),
    close_at: String(closeAt), resolve_by: String(closeAt + 7n * DAY),
    status: closeAt < started ? "closed" : "open", registered: true, outcome: null, refunds: false,
    locked: String(BigInt(pool) * USD + BigInt((i * 104729) % 1_000_000)),
    history: history(i, closeAt, target),
  };
  reprice(m, target);
  return m;
});

// The six resolution-state demos of dev_chain.rs: 0 open, 1 proposed, 2 disputed, 3 jury verdict, 4 nobody proposed, 5 final yes.
const jurors = ["juror0.test.near", "juror1.test.near", "juror2.test.near"];
const ago = (s) => String(now() - BigInt(s) * SEC);
const ahead = (s) => String(now() + BigInt(s) * SEC);
const base = { proposer: "carol.test.near", panel_deadline: ahead(1800), challenger: null, challenger_answer: null, round: 0, draw_by: "0", votes: [], final_outcome: null, applied: false, juror_share_bps: 5000, no_decision_share_bps: 5000 };
const cases = {
  1: () => ({ ...base, stage: "proposed", proposed: "yes", evidence: "Exchange closes on 4 November: 80,156 / 80,212 / 80,090 USD.", window_ends_at: ahead(540) }),
  2: () => ({ ...base, stage: "disputed", proposed: "yes", evidence: "Final score on uefa.com: Fenerbahçe 3, Liverpool 2.", window_ends_at: ago(30), challenger: "dave.test.near", challenger_answer: "no", draw_by: ahead(3600), challenged_at: ago(60), panel: jurors, commits: [{ juror: jurors[0], commitment: "9f2c…a71e" }], commit_ends_at: ahead(900), draw_after_height: "1200", delinquent: [] }),
  3: () => ({ ...base, stage: "final", proposed: "yes", evidence: "Brent traded above 100 USD early on 4 November.", window_ends_at: ago(400), challenger: "dave.test.near", challenger_answer: "no", challenged_at: ago(380), panel: jurors, commits: [], delinquent: [jurors[2]], final_outcome: "no", applied: true,
    votes: [{ juror: jurors[0], outcome: "no", reason: "The rule asks for the settlement. ICE settled Brent at 98.70 USD, below the line." }, { juror: jurors[1], outcome: "no", reason: "An intraday high is not a settlement price. It settled under 100 USD." }] }),
  5: () => ({ ...base, stage: "final", proposed: "yes", evidence: "AP called the House for the Democrats on 4 November.", window_ends_at: ago(200), final_outcome: "yes", applied: true }),
};
const caseOf = (id) => (cases[id] ? { case_uid: String(id + 1), ...cases[id]() } : null);
Object.assign(markets[3], { status: "resolved", outcome: "no" });
Object.assign(markets[5], { status: "resolved", outcome: "yes" });

// Accounts. alice is the demo owner; her two agents trade on their own.
const ALICE = "alice.test.near";
const AGENTS = [
  { agent_id: "agt_atlas", name: "Atlas", near_account_id: "atlas.agents.test.near" },
  { agent_id: "agt_ember", name: "Ember", near_account_id: "ember.agents.test.near" },
];
const holdings = new Map(); // account -> Map(market id -> [yes, no])
const hold = (account) => holdings.get(account) ?? holdings.set(account, new Map()).get(account);
for (const [id, yes, no] of [[0, 142_500_000n, 0n], [3, 0n, 48_000_000n], [5, 85_000_000n, 0n], [6, 64_000_000n, 0n], [7, 0n, 30_000_000n], [14, 38_750_000n, 0n], [18, 52_000_000n, 0n]]) hold(ALICE).set(id, [yes, no]);
for (const [id, yes, no] of [[0, 61_000_000n, 0n], [8, 0n, 40_000_000n], [15, 27_500_000n, 0n]]) hold(AGENTS[0].near_account_id).set(id, [yes, no]);
for (const [id, yes, no] of [[21, 33_000_000n, 0n], [20, 18_000_000n, 0n]]) hold(AGENTS[1].near_account_id).set(id, [yes, no]);
const marketBalance = new Map([[ALICE, 126_400_000n], [AGENTS[0].near_account_id, 212_750_000n], [AGENTS[1].near_account_id, 88_300_000n]]);
const intentsBalance = new Map([[ALICE, 2_874_250_000n], [AGENTS[0].near_account_id, 40_000_000n], [AGENTS[1].near_account_id, 12_500_000n]]);
const walletBalance = new Map([[ALICE, 500_000_000n]]);
const get = (map, k) => map.get(k) ?? 0n;
const sharesOf = (id, account) => hold(account).get(id) ?? [0n, 0n];

const redeemable = (m, [yes, no]) => {
  if (m.outcome !== "yes" && m.outcome !== "no") return 0n;
  const [held, winners] = m.outcome === "yes" ? [yes, m.yes_shares] : [no, m.no_shares];
  return (held * BigInt(m.locked)) / BigInt(winners);
};
const positionsOf = (account) => [...hold(account).entries()].filter(([, [y, n]]) => y > 0n || n > 0n).sort(([a], [b]) => a - b).map(([id, [yes, no]]) => {
  const m = markets[id];
  return { market_id: String(id), yes: String(yes), no: String(no), status: m.status, outcome: m.outcome, redeemable: String(redeemable(m, [yes, no])) };
});

// Trading. A buy moves the price toward its side by how big it is against the pool.
const FEE_BPS = 200n;
function trade(account, id, side, amount, from = "market") {
  const m = markets[id];
  if (!m || m.status !== "open" || amount <= 0n) throw new Error("Smart contract panicked: market is not open");
  const purse = from === "intents" ? intentsBalance : marketBalance;
  if (account && get(purse, account) < amount) throw new Error("Smart contract panicked: not enough balance");
  const fee = (amount * FEE_BPS) / 10_000n, net = amount - fee;
  const p = Number(side === "yes" ? m.price_yes : m.price_no) / 1e6;
  const shares = BigInt(Math.floor(Number(net) / p));
  const impact = (Number(net) / Number(m.locked)) * 0.9;
  const price = clamp(Number(m.price_yes) / 1e6 + (side === "yes" ? impact : -impact));
  m.locked = String(BigInt(m.locked) + net);
  reprice(m, price);
  m.history.push({ at: String(now()), price_yes: Number(m.price_yes) });
  if (m.history.length > 600) m.history.splice(1, m.history.length - 600);
  if (account) {
    purse.set(account, get(purse, account) - amount);
    const [y, n] = sharesOf(id, account);
    hold(account).set(id, side === "yes" ? [y + shares, n] : [y, n + shares]);
  }
  return shares;
}
function sell(account, id, side, shares) {
  const m = markets[id], [y, n] = sharesOf(id, account);
  if (!m || m.status !== "open" || shares > (side === "yes" ? y : n)) throw new Error("Smart contract panicked: not enough shares");
  const gross = BigInt(Math.floor(Number(shares) * Number(side === "yes" ? m.price_yes : m.price_no) / 1e6));
  const out = gross - (gross * FEE_BPS) / 10_000n;
  const impact = (Number(gross) / Number(m.locked)) * 0.9;
  m.locked = String(BigInt(m.locked) - gross);
  reprice(m, clamp(Number(m.price_yes) / 1e6 + (side === "yes" ? -impact : impact)));
  m.history.push({ at: String(now()), price_yes: Number(m.price_yes) });
  hold(account).set(id, side === "yes" ? [y - shares, n] : [y, n - shares]);
  marketBalance.set(account, get(marketBalance, account) + out);
  return out;
}

// The latest trades, newest first, for anything that wants to show the market moving.
const trades = [];
const TRADERS = ["kestrel.near", "quietfox.near", "0xmira.near", "ledger-lark.near", "hollow.near", "tidewater.near", "fennec.near", "brass-owl.near", "cinder.near", "marlowe.near", "juno-k.near", "sablewing.near"];
let receiptSeq = 0;
const record = (account, id, side, amount, kind = "buy") => {
  const at = Date.now();
  trades.unshift({ account, market_id: String(id), side, amount: String(amount), kind, at: String(BigInt(at) * 1_000_000n), height: height(at),
    receipt: `mockReceipt${(receiptSeq++).toString(36).padStart(6, "0")}`, price_yes: markets[id].price_yes });
  trades.length = Math.min(trades.length, 400);
};

// Agent operations, newest first, as the backend lists them.
const operations = new Map(AGENTS.map((a) => [a.agent_id, []]));
let opSeq = 1;
const pushOp = (agentId, action, state = "confirmed", minutesAgo = 0) => {
  const op = { id: `op_${opSeq++}`, kind: action.kind, state, transaction_hash: state === "confirmed" ? `${(opSeq * 7919).toString(36)}mockTx${opSeq}` : null,
    evidence: null, action, updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() };
  operations.get(agentId).unshift(op);
  operations.get(agentId).length = Math.min(operations.get(agentId).length, 12);
  return op;
};
pushOp("agt_atlas", { kind: "buy", market: "15", side: "yes", amount: "10000000", minShares: "0" }, "confirmed", 96);
pushOp("agt_atlas", { kind: "buy", market: "8", side: "no", amount: "15000000", minShares: "0" }, "confirmed", 41);
pushOp("agt_atlas", { kind: "buy", market: "0", side: "yes", amount: "25000000", minShares: "0" }, "confirmed", 12);
pushOp("agt_ember", { kind: "stake", series: 0, round: "0", side: "up", amount: "5000000", minShares: "0" }, "confirmed", 30);
pushOp("agt_ember", { kind: "buy", market: "21", side: "yes", amount: "12000000", minShares: "0" }, "confirmed", 8);

// Price rounds: five-minute Up or Down rounds on three assets.
const ROUND_NS = 300n * SEC;
const SERIES = [[0, "BTC"], [1, "ETH"], [2, "NEAR"]];
const roundNow = () => now() / ROUND_NS;
const openRounds = () => SERIES.map(([series_id, asset]) => {
  const r = roundNow();
  return { series_id, asset, round: String(r), opens_at: String(r * ROUND_NS), closes_at: String((r + 1n) * ROUND_NS - 30n * SEC) };
});

function simulate(r) {
  const open = markets.filter((m) => m.status === "open");
  const weights = open.map((m) => Number(m.locked));
  let pick = r() * weights.reduce((a, b) => a + b, 0), m = open[0];
  for (let i = 0; i < open.length; i++) if ((pick -= weights[i]) <= 0) { m = open[i]; break; }
  const target = SPECS[Number(m.id)][6], price = Number(m.price_yes) / 1e6;
  const side = r() < 0.5 + (target - price) * 4 ? "yes" : "no";
  const amount = BigInt(Math.round((5 + r() ** 3 * 900) * 1e6));
  trade(null, Number(m.id), side, amount);
  record(TRADERS[Math.floor(r() * TRADERS.length)], m.id, side, amount);
}
function agentTurn(r) {
  const agent = AGENTS[Math.floor(r() * AGENTS.length)], account = agent.near_account_id;
  const pool = agent.agent_id === "agt_atlas" ? [0, 7, 8, 9, 14, 15, 16] : [18, 19, 20, 21, 22];
  const id = pool[Math.floor(r() * pool.length)], target = SPECS[id][6];
  const side = target >= Number(markets[id].price_yes) / 1e6 ? "yes" : "no";
  const amount = BigInt(Math.round((4 + r() * 16) * 1e6));
  if (get(marketBalance, account) < amount) marketBalance.set(account, get(marketBalance, account) + 100_000_000n);
  const op = pushOp(agent.agent_id, { kind: "buy", market: String(id), side, amount: String(amount), minShares: "0" }, "submitted");
  setTimeout(() => {
    try { trade(account, id, side, amount); record(account, id, side, amount); op.state = "confirmed"; }
    catch { op.state = "failed"; }
    op.transaction_hash = `${(Date.now() % 1e9).toString(36)}mockTx`;
    op.updated_at = new Date().toISOString();
  }, 2600);
}
if (LIVE) {
  const r = rng(Date.now() % 100_000);
  for (let i = 0; i < 24; i++) simulate(r);
  setInterval(() => simulate(r), 1400);
  setInterval(() => agentTurn(r), 11_000);
}

const pub = (m) => { const { history, ...rest } = m; void history; return rest; };
const lockedTotal = () => markets.reduce((sum, m) => sum + BigInt(m.locked), 0n);
const FEES = 3_250_000n, REVENUE_DUE = 1_000_000n, TREASURY_DUE = 1_000_000n;
const SEATS = {
  7: { owner: ALICE, staked_at: String(started - 12n * DAY), unlock_requested_at: null, serving: null, earn_from_day: String(started / DAY) },
  8: { owner: ALICE, staked_at: String(started - 20n * DAY), unlock_requested_at: String(started + 30n * SEC), serving: null, earn_from_day: String(started / DAY) },
  9: { owner: ALICE, staked_at: String(started - 30n * DAY), unlock_requested_at: String(started - 2n * DAY), serving: null, earn_from_day: String(started / DAY) },
  10: { owner: ALICE, staked_at: String(started - 40n * DAY), unlock_requested_at: null, serving: "3", earn_from_day: String(started / DAY) },
};
const account = (id, registered) => ({ registered, available: String(get(marketBalance, id)), pending_withdrawals: "0", positions: positionsOf(id).length });

const views = {
  [MARKET]: {
    config: () => ({
      state_version: 2, upgrade_proven: false, upgrade_in_flight: false,
      owner: "owner.test.near", pending_owner: null, operator: "keeper.test.near", oracle: ORACLE,
      verifier: VERIFIER, collateral_token_id: "nep141:ft.test.near",
      paused: false, sells_paused: false, markets: String(markets.length), storage_deposit: "50000000000000000000000",
      max_positions: 20, fee_rate_bps: 200,
      revenue_pool: "council.test.near", treasury: "treasury.test.near",
      revenue_share_bps: 2500, treasury_share_bps: 7500,
      min_sweep: "1000000", next_sweep_id: "1", revenue_unresolved: "0",
      void_grace_ns: String(7n * 24n * 3600n * SEC),
      settle_wait_minutes: 10, reconcile_wait_minutes: 60, min_sweep_interval_minutes: 60,
      max_fee_rate_bps: 500, min_revenue_share_bps: 1000, max_revenue_share_bps: 5000, max_min_sweep: "100000000",
    }),
    list_markets: ({ from_index = "0", limit = "50" }) => markets.slice(Number(from_index), Number(from_index) + Number(limit)).map(pub),
    get_market: ({ market_id }) => (markets[Number(market_id)] ? pub(markets[Number(market_id)]) : null),
    get_history: ({ market_id }) => markets[Number(market_id)]?.history ?? [],
    get_balance: ({ account_id }) => String(get(marketBalance, account_id)),
    get_positions: ({ account_id }) => positionsOf(account_id),
    get_account: ({ account_id }) => account(account_id, marketBalance.has(account_id)),
    recent_trades: ({ limit = 20 }) => trades.slice(0, Number(limit)),
    in_flight: () => ({ withdrawals: "0", withdrawal_count: 0, legs: "0", leg_count: 0 }),
    owed_breakdown: () => {
      const balances = [...marketBalance.values()].reduce((a, b) => a + b, 0n);
      return { balances: String(balances), locked: String(lockedTotal()), fees: String(FEES), revenue_due: String(REVENUE_DUE),
        treasury_due: String(TREASURY_DUE), unresolved: "0", pending_withdrawals: "0",
        total: String(balances + lockedTotal() + FEES + REVENUE_DUE + TREASURY_DUE) };
    },
    get_shares: ({ market_id, account_id }) => sharesOf(Number(market_id), account_id).map(String),
    is_registered: ({ account_id }) => marketBalance.has(account_id),
    quote_buy: ({ market_id, side, amount }) => {
      const m = markets[Number(market_id)], a = BigInt(amount), fee = (a * FEE_BPS) / 10_000n;
      const p = Number(side === "yes" ? m.price_yes : m.price_no) / 1e6;
      return { shares_out: String(BigInt(Math.floor(Number(a - fee) / p))), fee: String(fee) };
    },
    quote_sell: ({ market_id, side, shares }) => {
      const m = markets[Number(market_id)];
      const gross = BigInt(Math.floor(Number(shares) * Number(side === "yes" ? m.price_yes : m.price_no) / 1e6));
      const fee = (gross * FEE_BPS) / 10_000n;
      return { collateral_out: String(gross - fee), shares_in: shares, fee: String(fee) };
    },
  },
  [ORACLE]: {
    get_case: ({ market, market_id }) => (market === MARKET ? caseOf(Number(market_id)) : null),
    list_cases: ({ market, from_market_id, limit }) => (market !== MARKET ? [] : Object.keys(cases).map(Number)
      .filter((id) => id >= Number(from_market_id) && id < Number(from_market_id) + Math.min(Number(limit), 50))
      .map((id) => {
        const c = caseOf(id);
        return {
          market: MARKET, market_id: String(id), stage: c.stage, proposed: c.proposed, challenger_answer: c.challenger_answer, round: c.round,
          final_outcome: c.final_outcome, applied: c.applied, votes: c.votes.length, window_ends_at: c.window_ends_at,
          draw_by: c.draw_by, panel_deadline: c.panel_deadline,
        };
      })),
    bond_totals: () => ({ bonds_held: String(2n * 50n * USD), claimable: "0", pending_payouts: "0", total: String(2n * 50n * USD) }),
    get_market_info: ({ market, market_id }) => {
      const m = market === MARKET ? markets[Number(market_id)] : null;
      if (!m) return null;
      return {
        close_at: m.close_at, resolve_by: m.resolve_by, rule_hash: m.rule_hash, price_rule: null,
        window_ns: String(600n * SEC), panel_deadline_ns: String(1800n * SEC), draw_window_ns: String(3600n * SEC), apply_buffer_ns: String(600n * SEC),
      };
    },
    config: () => ({
      markets: [MARKET], bond: String(50n * USD), window_ns: String(600n * SEC), panel_deadline_ns: String(1800n * SEC), council: "council.test.near", jury_size: 3, draw_delay_blocks: "5",
      apply_buffer_ns: String(600n * SEC), juror_share_bps: 5000, no_decision_share_bps: 5000, max_publishers: 10, reconcile_wait_ns: String(DAY),
    }),
    claimable_of: () => "0",
  },
  [COUNCIL]: {
    config: () => ({
      verifier: VERIFIER, collateral_token_id: "nep141:ft.test.near", markets: [MARKET], nft_contract: NFT,
      cooldown_ns: String(60n * SEC), max_seats_per_account: 5, allowlist_enabled: true,
      reconcile_wait_ns: String(3600n * SEC), last_day: String(started / DAY), active_seats: 28,
    }),
    seat_count: () => 31,
    seats_of: ({ account_id }) => (account_id === ALICE ? Object.keys(SEATS) : []),
    stake_of: ({ token_id }) => SEATS[token_id] ?? null,
    is_allowed: ({ token_id }) => Number(token_id) < 30,
    claimable_of: ({ account_id }) => (account_id === ALICE ? "4250000" : "0"),
    in_progress_of: ({ account_id }) => (account_id === ALICE ? "1800000" : "0"),
    quarter_info: () => ({ quarter: 8107, starts_at: "1790812800000000000", ends_at: "1798761600000000000", last_closed_quarter: 8106 }),
    seat_earnings: ({ token_id }) => {
      const s = SEATS[token_id];
      if (!s) return null;
      const state = s.serving !== null ? "serving" : s.unlock_requested_at !== null ? "leaving" : "earning";
      return { owner: s.owner, state, earning_from: String(BigInt(s.earn_from_day) * DAY), earned_closed: state === "earning" ? "1250000" : "0", earned_in_progress: state === "earning" ? "600000" : "0" };
    },
  },
  [NFT]: {
    nft_tokens_for_owner: ({ account_id }) => (account_id === ALICE ? ["21", "22", "35"].map((token_id) => ({ token_id, owner_id: ALICE })) : []),
    nft_token: ({ token_id }) => (["21", "22", "35"].includes(token_id) ? { token_id, owner_id: ALICE } : null),
  },
  [VERIFIER]: { mt_balance_of: ({ account_id }) => String(get(intentsBalance, account_id)) },
  [TOKEN]: { ft_balance_of: ({ account_id }) => String(get(walletBalance, account_id)) },
  [ROUNDS]: {
    config: () => ({ min_stake: "1000000", max_open_stakes: 3, paused: false, storage_deposit: "50000000000000000000000" }),
    open_rounds: () => openRounds(),
    get_stake: () => null,
    quote_stake: ({ amount }) => String((BigInt(amount) * 98n) / 50n),
    get_account: ({ account_id }) => ({ registered: AGENTS.some((a) => a.near_account_id === account_id), available: account_id === AGENTS[1].near_account_id ? "24500000" : "0", pending_withdrawals: "0", open_stakes: 0 }),
  },
};

// sandbox_send: what the chain would do with a dev account's transaction, applied straight to the state above.
function applySend({ signer_id: signer, receiver_id: receiver, actions = [] }) {
  for (const { params = {} } of actions) {
    const { methodName: method, args = {} } = params;
    if (receiver === VERIFIER && method === "mt_transfer_call" && args.receiver_id === MARKET) {
      const [verb, id, side] = String(args.msg).split(":");
      if (verb === "buy") { trade(signer, Number(id), side, BigInt(args.amount), "intents"); record(signer, id, side, BigInt(args.amount)); }
      else if (args.msg === "deposit") {
        if (get(intentsBalance, signer) < BigInt(args.amount)) throw new Error("Smart contract panicked: not enough balance");
        intentsBalance.set(signer, get(intentsBalance, signer) - BigInt(args.amount));
        marketBalance.set(signer, get(marketBalance, signer) + BigInt(args.amount));
      }
    } else if (receiver === MARKET && method === "buy") { trade(signer, Number(args.market_id), args.side, BigInt(args.amount)); record(signer, args.market_id, args.side, BigInt(args.amount)); }
    else if (receiver === MARKET && method === "sell") { sell(signer, Number(args.market_id), args.side, BigInt(args.shares)); record(signer, args.market_id, args.side, BigInt(args.shares), "sell"); }
    else if (receiver === MARKET && method === "redeem") {
      const id = Number(args.market_id), out = redeemable(markets[id], sharesOf(id, signer));
      hold(signer).delete(id);
      marketBalance.set(signer, get(marketBalance, signer) + out);
    } else if (receiver === MARKET && method === "withdraw") {
      const amount = BigInt(args.amount);
      if (get(marketBalance, signer) < amount) throw new Error("Smart contract panicked: not enough balance");
      marketBalance.set(signer, get(marketBalance, signer) - amount);
      intentsBalance.set(signer, get(intentsBalance, signer) + amount);
    } else throw new Error(`mock chain does not simulate ${receiver}.${method}`);
  }
  return { transaction: { hash: `mock${Date.now().toString(36)}` }, status: { SuccessValue: "" } };
}

function handle(body) {
  if (body.method === "sandbox_send") {
    try { return { result: applySend(body.params ?? {}) }; }
    catch (e) { return { error: { message: e.message, data: e.message } }; }
  }
  if (body.method === "block") return { result: { header: { height: height(), timestamp_nanosec: String(now()), hash: "mock" } } };
  if (body.method === "EXPERIMENTAL_tx_status") return { result: { status: { SuccessValue: "" }, receipts_outcome: [] } };
  if (body.method !== "query") return { error: { message: `mock chain does not answer ${body.method}` } };
  const { request_type: type, account_id: id, method_name, args_base64 } = body.params ?? {};
  if (type === "view_account") return { result: { amount: String(id?.endsWith(".agents.test.near") ? 1_840_000_000_000_000_000_000_000n : 25n * NEAR), locked: "0", storage_usage: 512, block_height: 1, block_hash: "mock" } };
  if (type !== "call_function") return { error: { message: `mock chain does not answer ${type}` } };
  const fn = views[id]?.[method_name];
  if (!fn) return { result: { error: `wasm execution failed: MethodNotFound ${id}.${method_name}`, logs: [] } };
  const args = args_base64 ? JSON.parse(Buffer.from(args_base64, "base64").toString() || "{}") : {};
  const out = Buffer.from(JSON.stringify(fn(args)));
  return { result: { result: [...out], logs: [], block_height: 1, block_hash: "mock" } };
}

// The e2e specs read the chain layout from contracts/dev-chain.json; write one unless a real chain already did.
const layout = new URL("../../contracts/dev-chain.json", import.meta.url);
if (!existsSync(layout)) writeFileSync(layout, JSON.stringify({
  mock: true, rpc: `http://127.0.0.1:${PORT}`, market: MARKET, oracle: ORACLE, token: TOKEN, verifier: VERIFIER, count: markets.length,
  markets: { open: 0, proposed: 1, disputed: 2, verdict: 3, nobody: 4, final_yes: 5 },
  accounts: { owner: "owner.test.near", alice: ALICE, bob: "bob.test.near", carol: "carol.test.near", dave: "dave.test.near", jurors },
}, null, 2));

const readBody = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => resolve(raw));
});

http.createServer(async (req, res) => {
  const raw = await readBody(req);
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  let body;
  try { body = JSON.parse(raw); } catch { res.statusCode = 400; return res.end(); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...handle(body) }));
}).listen(PORT, "127.0.0.1", () => console.log(`MOCK_CHAIN_READY http://127.0.0.1:${PORT}`));

// ---- the backend's agent API, as much of it as the agents page reads ----------------------------------------
const iso = (days) => new Date(Date.now() + days * DAY_MS).toISOString();
const DAY_MS = 86_400_000;
const watchlist = new Set(["0", "6", "7", "14", "18"].map((id) => `${MARKET}/${id}`));
const access = new Map([["agt_atlas", [{ id: "tok_1", label: "Claude Desktop", max_spend: "25000000", daily_limit: "100000000", expires_at: iso(60), last_used_at: new Date(Date.now() - 4 * 60_000).toISOString() }]], ["agt_ember", []]]);
const agentView = (a) => ({ ...a, state: "active", frozen: false, authorized_until: iso(84), open_intents: [] });
const roundsClaimable = { agt_ember: [{ series: 0, round: String(roundNow() - 3n), side: "up", amount: "5000000", outcome: "up" }], agt_atlas: [] };

function runAgentAction(agentId, { action }) {
  const agent = AGENTS.find((a) => a.agent_id === agentId);
  const op = pushOp(agentId, action, "confirmed");
  const who = agent.near_account_id;
  try {
    if (action.kind === "buy") { trade(who, Number(action.market), action.side, BigInt(action.amount)); record(who, action.market, action.side, BigInt(action.amount)); }
    else if (action.kind === "sell") sell(who, Number(action.market), action.side, BigInt(action.shares));
    else if (action.kind === "claim") roundsClaimable[agentId] = roundsClaimable[agentId].filter((s) => s.round !== action.round);
  } catch { op.state = "failed"; }
  return { operation: op.id, state: op.state, evidence: null };
}

const routes = [
  ["GET", /^\/v1\/config$/, () => ({ capabilities: { agents: true }, deployment: { collateralTokenId: "nep141:ft.test.near", contracts: { rounds: ROUNDS, market: MARKET } },
    agentCashOut: { perTransaction: "50000000", daily: "200000000" }, agentSpend: { perTransaction: "25000000", daily: "100000000" } })],
  ["GET", /^\/v1\/auth\/session$/, () => ({ session: { account_id: ALICE } })],
  ["POST", /^\/v1\/auth\/logout(-all)?$/, () => ({})],
  ["GET", /^\/v1\/agents$/, () => ({ data: AGENTS.map(agentView) })],
  ["GET", /^\/v1\/agents\/([^/]+)\/operations$/, (id) => ({ data: operations.get(id) ?? [] })],
  ["GET", /^\/v1\/agents\/([^/]+)\/claimable$/, (id) => ({ data: roundsClaimable[id] ?? [] })],
  ["GET", /^\/v1\/agents\/([^/]+)\/access$/, (id) => ({ data: access.get(id) ?? [] })],
  ["POST", /^\/v1\/agents\/([^/]+)\/actions$/, (id, body) => runAgentAction(id, body)],
  ["POST", /^\/v1\/agent-intents\/([^/]+)\/status$/, (id) => ({ correlation_id: id, status: "SUCCESS", failure_code: null })],
  ["GET", /^\/v1\/watchlist$/, () => ({ data: [...watchlist].map((item) => ({ item })) })],
  ["PUT", /^\/v1\/watchlist$/, (_, body) => { watchlist.add(body.item); return {}; }],
  ["DELETE", /^\/v1\/watchlist$/, (_, body) => { watchlist.delete(body.item); return {}; }],
  ["GET", /^\/v1\/settlements\/pending/, () => ({ data: [] })],
  ["GET", /^\/v1\/events$/, (_, __, q) => ({ data: trades
    .filter((t) => t.kind === q.get("event") && (!q.get("fromBlock") || t.height >= Number(q.get("fromBlock"))))
    .slice(0, Number(q.get("limit") ?? 50)).reverse()
    .map((t) => ({ block_height: String(t.height), block_hash: "mock", block_timestamp_ns: t.at, receiver_id: MARKET, receipt_id: t.receipt,
      log_index: 0, data_index: 0, standard: "market", version: "1.0.0", event: t.kind,
      payload: { market_id: t.market_id, account: t.account, side: t.side, collateral: t.amount, price_yes: t.price_yes } })) })],
  ["GET", /^\/v1\/events$/, (_, __, q) => ({ data: trades
    .filter((t) => t.kind === q.get("event") && (!q.get("fromBlock") || t.height >= Number(q.get("fromBlock"))))
    .slice(0, Number(q.get("limit") ?? 50)).reverse()
    .map((t) => ({ block_height: String(t.height), block_hash: "mock", block_timestamp_ns: t.at, receiver_id: MARKET, receipt_id: t.receipt,
      log_index: 0, data_index: 0, standard: "market", version: "1.0.0", event: t.kind,
      payload: { market_id: t.market_id, account: t.account, side: t.side, collateral: t.amount, price_yes: t.price_yes } })) })],
];

http.createServer(async (req, res) => {
  const raw = await readBody(req);
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  res.setHeader("content-type", "application/json");
  const [path, search = ""] = req.url.split("?");
  for (const [method, pattern, fn] of routes) {
    const hit = req.method === method && path.match(pattern);
    if (!hit) continue;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* no body */ }
    return res.end(JSON.stringify(fn(hit[1], body, new URLSearchParams(search))));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: "not_found" } }));
}).on("error", (e) => console.error(`mock backend not started on :${BACKEND_PORT}: ${e.code ?? e.message}`))
  .listen(BACKEND_PORT, "127.0.0.1", () => console.log(`MOCK_BACKEND_READY http://127.0.0.1:${BACKEND_PORT}`));
