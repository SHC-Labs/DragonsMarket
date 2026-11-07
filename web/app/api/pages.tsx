import Link from "next/link";
import type { DocPage } from "@/components/DocsShell";
import { config } from "@/lib/config";

const mcp = (path: string) => (config.mcpUrl ? `${config.mcpUrl.replace(/\/$/, "")}${path}` : path);
const api = (path: string) => (config.backendUrl ? `${config.backendUrl}${path}` : path);

const clientConfig = `{
  "mcpServers": {
    "dragons-market": {
      "type": "http",
      "url": "${mcp("/mcp")}",
      "headers": { "Authorization": "Bearer <your dmk_ access token>" }
    }
  }
}`;

export const apiPages: DocPage[] = [
  {
    slug: "",
    title: "Overview",
    group: "Start here",
    description: "Two ways to build on Dragons Market: an AI agent through MCP, or the public read API.",
    content: <>
      <p>There are two ways to build on Dragons Market.</p>
      <ul>
        <li><strong>An AI agent through MCP.</strong> Your agent trades event markets and stakes price rounds from an account you fund, within limits you sign. Start with <Link href="/api/connect">Connect an AI agent</Link>.</li>
        <li><strong>The read API.</strong> Read what the indexer has recorded from the Dragons Market contracts: events, receipts and pending settlements. No account needed. Start with <Link href="/api/endpoints">Endpoints</Link>.</li>
      </ul>
      <p>Neither one can reach your wallet. An agent spends only from its own balances, and cashes out only to you.</p>
    </>,
  },
  {
    slug: "connect",
    title: "Connect an AI agent",
    group: "AI agents (MCP)",
    description: "Create an agent account, give it access with your limits, and connect it to an MCP client.",
    content: <>
      <p>An agent trades from its own account, never from your wallet. You create it, fund it and set its limits on the <Link href="/agents">Agents page</Link>.</p>
      <ol>
        <li>Create an agent account and fund its market balance, its rounds balance, or both.</li>
        <li>Give access: name the connection, set how much it may spend on one buy or stake and in any 24 hours, then sign the request with your wallet.</li>
        <li>Copy the three values the page shows: the MCP server, the <code>Authorization</code> header with your <code>dmk_</code> access token, and the skill.</li>
      </ol>
      <p>The MCP server is <code>{mcp("/mcp")}</code> and the skill is <code>{mcp("/skill.md")}</code>. Most MCP clients take a configuration like this:</p>
      <pre><code>{clientConfig}</code></pre>
      <p>Keep the token private. Anyone holding it can act for the agent within your limits. You can revoke a connection from the Agents page at any time, and it stops working straight away.</p>
    </>,
  },
  {
    slug: "balances",
    title: "Where the money is",
    group: "AI agents (MCP)",
    description: "The agent's market, rounds and NEAR Intents balances, and the one direction money moves.",
    content: <>
      <ul>
        <li><strong>Market balance</strong> pays for buys. Sells and redeems pay back into it.</li>
        <li><strong>Rounds balance</strong> pays for stakes. Claims pay winnings back into it.</li>
        <li><strong>NEAR Intents balance</strong> is where a withdrawal from either balance lands.</li>
        <li><strong>Your wallet</strong> is the only place a cash out can go.</li>
      </ul>
      <p>Money moves one way: from a market or rounds balance, to the NEAR Intents balance, to you. An agent cannot move money back into a market or round, and cannot send it anywhere else. Only you fund it.</p>
    </>,
  },
  {
    slug: "tools",
    title: "Tools",
    group: "AI agents (MCP)",
    description: "Every tool the Dragons Market MCP server offers, grouped by what it does.",
    content: <>
      <h2>Reading</h2>
      <ul>
        <li><code>get_agent</code>: balances, whether the agent is frozen or authorized, and your limits with what is left of them.</li>
        <li><code>list_markets</code>: event markets open now, with each question, rule, closing time and prices.</li>
        <li><code>list_positions</code>: shares held in each market, its status, and what a redeem would pay now.</li>
        <li><code>list_rounds</code>: each price series and the round taking stakes now or next to open.</li>
        <li><code>list_claimable</code>: stakes in rounds that have an outcome and can be claimed.</li>
        <li><code>list_operations</code>: recent actions, newest first, with where each one stands.</li>
      </ul>
      <h2>Markets</h2>
      <ul>
        <li><code>quote_buy</code> then <code>buy</code>: buy shares of an answer, passing the quote&apos;s <code>min_shares</code>.</li>
        <li><code>quote_sell</code> then <code>sell</code>: sell shares before the market closes, passing the quote&apos;s <code>min_collateral</code>.</li>
        <li><code>redeem</code>: pay out the shares of a resolved market.</li>
      </ul>
      <h2>Price rounds</h2>
      <ul>
        <li><code>quote_stake</code> then <code>stake</code>: stake on up or down in a round that is taking stakes.</li>
        <li><code>claim</code>: settle a stake that <code>list_claimable</code> names.</li>
      </ul>
      <h2>Money out</h2>
      <ul>
        <li><code>withdraw</code>: move money from the market or rounds balance into the NEAR Intents balance.</li>
        <li><code>cash_out</code>: pay money from the NEAR Intents balance to your wallet.</li>
      </ul>
      <p>The server also offers the skill as a resource and a prompt named <code>trade-dragons-market</code>, so an agent can load the workflow and rules before it acts.</p>
    </>,
  },
  {
    slug: "actions",
    title: "Actions and outcomes",
    group: "AI agents (MCP)",
    description: "How request_id makes retries safe, and what each outcome means.",
    content: <>
      <p>Every action takes a <code>request_id</code> the agent chooses: 8 to 64 letters, digits, <code>-</code> or <code>_</code>. A new action gets a new one. A retry uses the same one with exactly the same arguments, and Dragons Market sends it once however many times it is asked. A retry under a new <code>request_id</code> is a second action and can spend twice.</p>
      <h2>Outcomes</h2>
      <ul>
        <li><code>done</code>: it happened on chain.</li>
        <li><code>refused</code>: it did not happen, and nothing more will come of it.</li>
        <li><code>settling</code>: it was sent and has not settled yet. Ask again with the same <code>request_id</code> until it is done or refused.</li>
        <li><code>needs_owner</code>: Dragons Market could not prove what happened and stopped for you to check. It may have landed, so the agent must not retry it.</li>
      </ul>
      <h2>Amounts</h2>
      <p>Amounts are decimals of the collateral, such as <code>5</code> or <code>2.5</code> USDC. Shares, <code>min_shares</code> and <code>min_collateral</code> are whole numbers, copied exactly from the quote.</p>
    </>,
  },
  {
    slug: "refusals",
    title: "Limits and refusals",
    group: "AI agents (MCP)",
    description: "The refusal codes an agent can receive and what each one means.",
    content: <>
      <ul>
        <li><code>spend_over_limit</code>: the buy or stake is above your limit for one.</li>
        <li><code>daily_limit_reached</code>: your limit for the last 24 hours is used up.</li>
        <li><code>slippage_too_wide</code>: the minimum is more than 10% worse than the price now, or the price moved past it. Nothing was sent.</li>
        <li><code>wallet_frozen</code>: you froze the agent. Nothing moves until you unfreeze it.</li>
        <li><code>custody_native_balance_required</code>: the agent needs more NEAR for gas.</li>
        <li><code>grant_required</code>: you have not authorized Dragons Market for this agent, or stopped it.</li>
        <li><code>access_token_invalid</code>: the access was revoked or has expired.</li>
        <li><code>operation_idempotency_conflict</code>: that <code>request_id</code> already names a different action.</li>
      </ul>
      <p>A token that sends too many requests in a short time is turned away briefly and can try again soon after.</p>
    </>,
  },
  {
    slug: "endpoints",
    title: "Endpoints",
    group: "Read API",
    description: "The public read API's endpoints for events, receipts, blocks, settlements and price signatures.",
    content: <>
      <p>The read API serves what the indexer has recorded from the Dragons Market contracts. It needs no account and sends no transactions.</p>
      <ul>
        <li><code>GET {api("/v1/events")}</code>: contract events with their exact values and receipt identities.</li>
        <li><code>GET {api("/v1/receipts")}</code>: receipt outcomes, failed ones included.</li>
        <li><code>GET {api("/v1/receipts/:receiptId")}</code>: one receipt&apos;s outcome.</li>
        <li><code>GET {api("/v1/transactions/:transactionHash/receipts")}</code>: the receipts a transaction produced in the Dragons Market contracts.</li>
        <li><code>GET {api("/v1/blocks")}</code>: indexed block headers.</li>
        <li><code>GET {api("/v1/settlements/pending")}</code>: withdrawals, bond payouts and Council claims that were requested and have not finished yet. Takes <code>limit</code> and <code>account</code>.</li>
        <li><code>GET {api("/v1/price-signatures?seriesId=N&round=R")}</code>: the signed prices for a round, each with the message that was signed.</li>
      </ul>
      <pre><code>{`curl '${api("/v1/events?standard=rounds&limit=20")}'`}</code></pre>
      <p>A receipt in this API shows what the indexer saw. It does not by itself prove that every later step of a transaction succeeded.</p>
    </>,
  },
  {
    slug: "paging",
    title: "Filters and paging",
    group: "Read API",
    description: "Query parameters, cursors and the response format of the read API.",
    content: <>
      <h2>Filters</h2>
      <p>Events, receipts and blocks take <code>limit</code> (50 by default, at most 100), <code>cursor</code>, <code>fromBlock</code> and <code>toBlock</code>. Events can also filter by <code>receiver</code>, <code>standard</code>, <code>event</code> and <code>receiptId</code>, and receipts by <code>receiver</code>. Unknown or repeated parameters return 400.</p>
      <h2>Responses</h2>
      <p>Lists return <code>data</code>, <code>nextCursor</code> and <code>asOf</code>, the block the page was read at. Heights, timestamps and amounts are exact decimal strings, so read them as strings, not numbers.</p>
      <h2>Paging</h2>
      <p>Follow <code>nextCursor</code> to read the next page, and keep the same filters while you do. A cursor fixes the block the walk started from, so new blocks appear when you start a fresh walk.</p>
    </>,
  },
  {
    slug: "status",
    title: "Service status",
    group: "Read API",
    description: "Health checks for the read API and the MCP server.",
    content: <>
      <ul>
        <li><code>GET {api("/v1/health/services")}</code> answers <code>ok</code> or <code>degraded</code>.</li>
        <li><code>GET {mcp("/health/ready")}</code> answers <code>ready</code> when the MCP server can reach the API behind it.</li>
      </ul>
    </>,
  },
];
