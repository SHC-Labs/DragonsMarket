// A stand-in for the local dev chain (contracts/tests/tests/dev_chain.rs) for UI work on machines without
// Rust or the NEAR sandbox. Answers the JSON-RPC view calls the site makes with the same 21 markets and the
// same six resolution states. Read-only: transactions are not simulated.
//   node scripts/mock-chain.mjs            listens on 127.0.0.1:3030 (MOCK_CHAIN_PORT overrides)
import http from "node:http";
import { existsSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_CHAIN_PORT ?? 3030);
const MARKET = "market.test.near", ORACLE = "oracle.test.near", TOKEN = "ft.test.near", VERIFIER = "intents.test.near";
const SEC = 1_000_000_000n, DAY = 86_400n * SEC, USD = 1_000_000n;
const now = () => BigInt(Date.now()) * 1_000_000n;
const started = now();

const SPECS = [
  ["Will the Fed raise rates at its next meeting?", "https://www.federalreserve.gov/newsevents/pressreleases.htm", "The meeting is cancelled or postponed past 31 December.", "economy", "fed", 30],
  ["Will bitcoin close above 85,000 USD today?", "Median of the closing prices on three major exchanges", "Fewer than two of the three exchanges publish a closing price.", "crypto", "bitcoin", -0.01],
  ["Will the Yankees beat the Rays tonight?", "https://www.mlb.com/scores", "The game is postponed or suspended and not completed within 3 days.", "sports", "mlb", -0.01],
  ["Will Tropical Storm Isaias become a hurricane by Friday?", "https://www.nhc.noaa.gov", "The storm dissipates before Friday without ever reaching hurricane strength.", "world", "weather", -0.02],
  ["Will Houston's high temperature exceed 80F today?", "National Weather Service daily summary", "The summary is not published within 7 days.", "world", "weather", -0.01],
  ["Will Gemini 4 be released to the public by 15 October?", "https://blog.google", "Google withdraws the announcement before the date.", "tech", "ai", -0.02],
  ["Will Republicans keep control of the Senate after the November midterms?", "Associated Press race calls", "Control is not decided by 31 January 2027.", "politics", "congress", 40],
  ["Will Democrats win the House in the 2026 midterms?", "Associated Press race calls", "Control is not decided by 31 January 2027.", "politics", "us-elections", 40],
  ["Will Netanyahu be Israel's next prime minister?", "Israel Central Elections Committee", "The election is cancelled or postponed past 31 March 2027.", "politics", "world-elections", 45],
  ["Will Flavio Bolsonaro win the Brazil presidential runoff?", "TSE, Brazil's electoral court", "The runoff is cancelled or postponed past 31 December.", "politics", "world-elections", 20],
  ["Will the Chiefs win the 2027 Super Bowl?", "https://www.nfl.com", "The game is not played by 28 February 2027.", "sports", "nfl", 120],
  ["Will the Lakers win the 2027 NBA championship?", "https://www.nba.com", "The Finals are not completed by 30 June 2027.", "sports", "nba", 200],
  ["Will Verstappen win the 2026 F1 drivers' championship?", "https://www.fia.com", "The season is cancelled before the final race.", "sports", "f1", 60],
  ["Will Arsenal win the 2026-27 Premier League?", "https://www.premierleague.com", "The season is abandoned.", "sports", "soccer", 220],
  ["Will the 2030 World Cup open with a match in Uruguay?", "https://www.fifa.com", "FIFA announces no opening match before 31 December 2029.", "sports", "world-cup", 300],
  ["Will bitcoin reach 100,000 USD before 2027?", "Median of the prices on three major exchanges", "Fewer than two of the three exchanges publish a price.", "crypto", "bitcoin", 80],
  ["Will NEAR Intents pass 30 billion USD in all-time volume by year end?", "The public NEAR Intents dashboard", "The dashboard is unavailable on 31 December.", "crypto", "near", 80],
  ["Will the 30-year mortgage rate exceed 7.5% in November?", "Freddie Mac weekly survey", "Freddie Mac does not publish a November survey.", "economy", "housing", 50],
  ["Will WTI crude touch 85 USD in October?", "CME settlement prices", "The CME does not publish settlements for the period.", "economy", "oil", 22],
  ["Will Rockstar release another GTA VI trailer by 31 October?", "Rockstar Games official channels", "Rockstar announces a new release date and no trailer before the deadline.", "tech", "gaming", 22],
  ["Will Tom Cruise be nominated for Best Actor at the 2027 Oscars?", "Academy of Motion Picture Arts and Sciences", "The ceremony is cancelled.", "culture", "awards", 100],
];

// Deterministic per-market random walk so every reload draws the same charts.
function rng(seed) {
  let s = seed * 2654435761 % 4294967296;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function history(index, closeAt) {
  const r = rng(index + 7);
  const end = closeAt < now() ? closeAt : now();
  const steps = 40 + Math.floor(r() * 50);
  const start = end - BigInt(10 + Math.floor(r() * 25)) * DAY;
  let p = 0.25 + r() * 0.5;
  const pts = [{ at: String(start), price_yes: 500_000 }];
  for (let i = 1; i <= steps; i++) {
    p = Math.min(0.97, Math.max(0.03, p + (r() - 0.5) * 0.08));
    const at = start + ((end - start) * BigInt(i)) / BigInt(steps);
    pts.push({ at: String(at), price_yes: Math.round(p * 1e6) });
  }
  return pts;
}

const markets = SPECS.map(([title, source, voidPolicy, category, sub, days], i) => {
  const closeAt = started + BigInt(Math.round(days * 86_400)) * SEC;
  const hist = history(i, closeAt);
  const price = hist[hist.length - 1].price_yes;
  return {
    id: String(i), title,
    rule_text: `Resolves Yes if the answer to "${title}" is yes according to the source below when the market closes. Resolves No otherwise.`,
    resolution_source: source, void_policy: voidPolicy, category, subcategory: sub,
    rule_hash: (BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(64, "0").slice(-64),
    close_at: String(closeAt), resolve_by: String(closeAt + 7n * DAY),
    status: closeAt < started ? "closed" : "open", registered: true, seeded: true, void_price_yes: null, outcome: null,
    price_yes: String(price), price_no: String(1_000_000 - price),
    locked: String((BigInt(200 + ((i * 7919) % 4800)) * USD) + BigInt((i * 104729) % 1_000_000)),
    history: hist,
  };
});

// The six resolution-state demos of dev_chain.rs: 0 open, 1 proposed, 2 disputed, 3 jury verdict, 4 nobody proposed, 5 final yes.
const jurors = ["juror0.test.near", "juror1.test.near", "juror2.test.near"];
const ago = (s) => String(now() - BigInt(s) * SEC);
const ahead = (s) => String(now() + BigInt(s) * SEC);
const base = { proposer: "carol.test.near", panel_deadline: ahead(1800), challenger: null, votes: [], final_outcome: null, applied: false };
const cases = {
  1: () => ({ ...base, stage: "proposed", proposed: "no", evidence: "Exchange closes: 83,912 / 84,105 / 83,990 USD.", window_ends_at: ahead(540) }),
  2: () => ({ ...base, stage: "disputed", proposed: "yes", evidence: "Final score on mlb.com: Yankees 5, Rays 3.", window_ends_at: ago(30), challenger: "dave.test.near", challenged_at: ago(60), panel: jurors, commits: [{ juror: jurors[0], commitment: "9f2c…a71e" }], commit_ends_at: ahead(900), draw_after_height: "1200", delinquent: [] }),
  3: () => ({ ...base, stage: "final", proposed: "yes", evidence: "NHC advisory 14 upgraded Isaias.", window_ends_at: ago(400), challenger: "dave.test.near", challenged_at: ago(380), panel: jurors, commits: [], delinquent: [jurors[2]], final_outcome: "no", applied: true,
    votes: [{ juror: jurors[0], outcome: "no", reason: "The hurricane centre's advisory still lists it as a tropical storm." }, { juror: jurors[1], outcome: "no", reason: "No hurricane advisory was issued before the deadline." }] }),
  5: () => ({ ...base, stage: "final", proposed: "yes", evidence: "Gemini 4 general availability post on blog.google.", window_ends_at: ago(200), final_outcome: "yes", applied: true }),
};
Object.assign(markets[3], { status: "resolved", outcome: "no" });
Object.assign(markets[5], { status: "resolved", outcome: "yes" });

// alice holds positions across open, closed and resolved markets so the portfolio has something to show.
const ALICE = "alice.test.near";
const holdings = { 0: [42_500_000n, 0n], 3: [0n, 18_000_000n], 5: [25_000_000n, 0n], 6: [12_000_000n, 3_000_000n], 12: [0n, 30_000_000n], 15: [8_750_000n, 0n] };
const sharesOf = (id, account) => (account === ALICE && holdings[id] ? holdings[id].map(String) : ["0", "0"]);

const pub = (m) => { const { history, ...rest } = m; void history; return rest; };
const quote = (m, side, amount) => {
  const p = Number(side === "yes" ? m.price_yes : m.price_no) / 1e6;
  const fee = (amount * 2n) / 100n;
  return { fee: String(fee), net: amount - fee, p };
};

const views = {
  [MARKET]: {
    list_markets: ({ from_index = "0", limit = "50" }) => markets.slice(Number(from_index), Number(from_index) + Number(limit)).map(pub),
    get_market: ({ market_id }) => (markets[Number(market_id)] ? pub(markets[Number(market_id)]) : null),
    get_history: ({ market_id }) => markets[Number(market_id)]?.history ?? [],
    get_balance: ({ account_id }) => (account_id === ALICE ? String(126_400_000n) : "0"),
    get_shares: ({ market_id, account_id }) => sharesOf(Number(market_id), account_id),
    is_registered: ({ account_id }) => account_id === ALICE,
    quote_buy: ({ market_id, side, amount }) => {
      const q = quote(markets[Number(market_id)], side, BigInt(amount));
      return { shares_out: String(BigInt(Math.floor(Number(q.net) / q.p))), fee: q.fee };
    },
    quote_sell: ({ market_id, side, shares }) => {
      const gross = BigInt(Math.floor(Number(shares) * quote(markets[Number(market_id)], side, 0n).p));
      const fee = (gross * 2n) / 100n;
      return { collateral_out: String(gross - fee), shares_in: shares, fee: String(fee) };
    },
  },
  [ORACLE]: {
    get_case: ({ market_id }) => cases[Number(market_id)]?.() ?? null,
    config: () => ({ bond: String(50n * USD), window_ns: String(600n * SEC), panel_deadline_ns: String(1800n * SEC), council: "council.test.near", jury_size: 3, draw_delay_blocks: "5" }),
    claimable_of: () => "0",
  },
  [VERIFIER]: { mt_balance_of: ({ account_id }) => (account_id === ALICE ? String(2_874_250_000n) : "0") },
};

function handle(body) {
  if (body.method !== "query" || body.params?.request_type !== "call_function") {
    return { error: { message: `mock chain does not answer ${body.method}` } };
  }
  const { account_id, method_name, args_base64 } = body.params;
  const fn = views[account_id]?.[method_name];
  if (!fn) return { result: { error: `wasm execution failed: MethodNotFound ${account_id}.${method_name}`, logs: [] } };
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

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return res.end();
    let body;
    try { body = JSON.parse(raw); } catch { res.statusCode = 400; return res.end(); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...handle(body) }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`MOCK_CHAIN_READY http://127.0.0.1:${PORT}`));
