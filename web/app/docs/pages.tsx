import Link from "next/link";
import type { DocPage } from "@/components/DocsShell";
import { config } from "@/lib/config";

const token = config.tokenSymbol;

export const docsPages: DocPage[] = [
  {
    slug: "",
    title: "Overview",
    group: "Start here",
    description: "What Dragons Market is and how its markets, price rounds and Council fit together.",
    content: <>
      <p>Dragons Market is a prediction market on NEAR where the rules come first. Every market publishes its question, rule, result source and closing time before anyone trades, and none of it can change once money is in.</p>
      <ul>
        <li><strong>Markets</strong> ask a question that ends Yes or No. You buy shares of the answer you expect, and sell them back any time before the market closes.</li>
        <li><strong>Price rounds</strong> follow one asset&apos;s price. Each round asks whether the price ends up or down, and you stake on one side.</li>
        <li><strong>The Dragon Council</strong> is the jury. When someone challenges a result, holders of staked Dragons vote on it, and Council seats share part of the trading fees.</li>
      </ul>
      <p>Your money stays in NEAR Intents and moves only when you sign. New here? Start with <Link href="/docs/markets">How a market works</Link>.</p>
    </>,
  },
  {
    slug: "markets",
    title: "How a market works",
    group: "Start here",
    description: "A market's question, rule, result source and closing time, and the life of a market from open to paid.",
    content: <>
      <p>A market is one Yes or No question. Before you trade, read four things on the market page:</p>
      <ul>
        <li><strong>The question and rule</strong>: exactly what counts as Yes, what counts as No, and when the market is void.</li>
        <li><strong>The result source</strong>: where the answer will be checked.</li>
        <li><strong>The closing time</strong>: trading stops at that moment.</li>
        <li><strong>The seal</strong>: a fingerprint of the question, rule, source and closing time. It proves the market was not reworded after money went in.</li>
      </ul>
      <h2>From open to paid</h2>
      <ol>
        <li>The market opens empty, at even odds.</li>
        <li>People buy and sell Yes and No shares until the closing time.</li>
        <li>After close, someone proposes the result and puts up a bond. If nobody challenges it in time, it stands. If someone does, the Dragon jury decides.</li>
        <li>Once the result is final, holders redeem their shares and withdraw.</li>
      </ol>
    </>,
  },
  {
    slug: "funding",
    title: "Funding your account",
    group: "Trading",
    description: "How your balance in NEAR Intents pays for trades, and where withdrawals go.",
    content: <>
      <p>Dragons Market uses {token} held in <strong>NEAR Intents</strong>, NEAR&apos;s shared account for tokens from many chains. You connect a NEAR wallet, and trades are paid from your NEAR Intents balance.</p>
      <ul>
        <li>A buy moves {token} from your NEAR Intents balance into the market.</li>
        <li>Sells and payouts go to your balance in that market, ready for your next trade.</li>
        <li>A withdrawal sends that balance back to your NEAR Intents account.</li>
      </ul>
      <p>Every move is a transaction you sign in your wallet. Check the amount and the network before you approve. A pending status is not a failure, so check the transaction before you try again.</p>
    </>,
  },
  {
    slug: "trading",
    title: "Buying and selling",
    group: "Trading",
    description: "How prices work, how to buy and sell shares, and how your minimum protects you.",
    content: <>
      <h2>Prices</h2>
      <p>The price of a side is the chance the market gives it. A Yes price of 40¢ means the market puts Yes at about 40%. Prices move with every trade: buying a side makes it cost more, and money on the other side makes it cost less.</p>
      <h2>Buying</h2>
      <p>Choose Yes or No, enter an amount in {token} and review the quote: the shares you get and the fee. Your money goes into the market&apos;s pool, and the fee is taken from the amount you pay in.</p>
      <h2>Selling</h2>
      <p>You can sell shares any time before the market closes. The quote shows what they fetch now, after the fee. A share is worth less to sell after money has gone onto the other side, and more after money has gone onto its own.</p>
      <h2>Your minimum</h2>
      <p>Every buy carries the fewest shares you accept, and every sale the least {token} you accept. If the price moves past it before your trade lands, the trade is refused and nothing is spent. You are never filled at a price you did not accept.</p>
    </>,
  },
  {
    slug: "rounds",
    title: "Price rounds",
    group: "Trading",
    description: "How price rounds work: staking up or down, closing before the end, and how a round pays.",
    content: <>
      <p>A price round follows one asset, such as BTC in USD, for a fixed interval. It asks one thing: does the price end higher or lower than it started?</p>
      <ul>
        <li><strong>Staking</strong> opens when the round starts and closes before it ends, so the last moves of the price cannot be staked on.</li>
        <li><strong>One side per round.</strong> You back up or down. A second stake on the same side adds to the first.</li>
        <li><strong>Pricing</strong> works like a market: the more of a side is already held, the more it costs. The quote shows the shares your stake buys.</li>
        <li><strong>The price</strong> at the start and end of each round is signed by independent price publishers and recorded on chain.</li>
      </ul>
      <h2>How a round pays</h2>
      <p>Up wins if the end price is above the start price, and down wins if it is below. Winning stakes share the round&apos;s pool, less the fee, which comes only from what the losing side paid. A winning stake never gets back less than it put in.</p>
      <p>A tie, a round with nobody on one side, or a round whose price was not recorded in time is a refund: every stake comes back in full, with no fee.</p>
    </>,
  },
  {
    slug: "payouts",
    title: "Getting paid",
    group: "Trading",
    description: "What winning, losing and void markets pay, and how to redeem and withdraw.",
    content: <>
      <h2>When the result is final</h2>
      <ul>
        <li><strong>Winning shares</strong> share the market&apos;s whole pool. Each one is paid its part, and never less than it cost.</li>
        <li><strong>Losing shares</strong> pay nothing.</li>
        <li><strong>A void market</strong> pays each holder back what they put in, less anything they already took out by selling. Fees are not refunded.</li>
      </ul>
      <p>If a market ends on an answer nobody holds, there is no winner to pay, so everyone still in is paid back as if it were void.</p>
      <h2>Redeem, then withdraw</h2>
      <p>Redeem turns all your shares in a market into balance at once. Withdraw then sends that balance to your NEAR Intents account. Redeeming has no deadline, and the order in which winners redeem does not change what each gets.</p>
    </>,
  },
  {
    slug: "results",
    title: "How results are decided",
    group: "Results and disputes",
    description: "How a result is proposed with a bond, challenged within a window, and made final.",
    content: <>
      <p>A result is decided in the open, by the rule the market published.</p>
      <ol>
        <li><strong>Propose.</strong> After the market closes, anyone can propose Yes, No or Void with a link to evidence. They put up a bond.</li>
        <li><strong>Challenge window.</strong> For a set time, anyone else can challenge by putting up the same bond and naming a different answer.</li>
        <li><strong>Final.</strong> If nobody challenges, the proposal becomes the result and the proposer gets the bond back. If someone challenges, the Dragon jury decides.</li>
      </ol>
      <p>Price markets work the same way, except the proposal is a price signed by independent publishers, and the contract works out Yes or No from it.</p>
      <p>If no result is reached by the market&apos;s deadline, the market settles what it can and voids the rest, so money is never stuck waiting forever.</p>
    </>,
  },
  {
    slug: "disputes",
    title: "Challenges and the jury",
    group: "Results and disputes",
    description: "How a jury of staked Dragons is drawn, votes in secret, and who is paid when a dispute ends.",
    content: <>
      <h2>The jury</h2>
      <p>When a result is challenged, a jury is drawn at random from staked Dragon seats. The proposer and the challenger are never on it, and nobody knows who is on it when they challenge.</p>
      <h2>Voting</h2>
      <ol>
        <li><strong>Commit.</strong> In the first half of the jury&apos;s time, each juror locks in a sealed vote.</li>
        <li><strong>Reveal.</strong> In the second half, jurors open their votes with a written reason. Votes and reasons are public.</li>
      </ol>
      <p>A juror can vote only for the proposed answer or the challenger&apos;s. The moment one answer has a majority of the jury, the case is decided. If the first jury does not decide in time, one larger jury of other holders is drawn.</p>
      <h2>Who is paid</h2>
      <ul>
        <li>The side the jury backs gets both bonds back, less the jurors&apos; share.</li>
        <li>Jurors who revealed and voted with the result share that part.</li>
        <li>If neither jury decides, the proposal stands and the challenger loses half of their bond, shared among the jurors who revealed.</li>
      </ul>
      <p>Challenging always costs something when you are wrong, so stalling a market on purpose does not pay.</p>
    </>,
  },
  {
    slug: "seats",
    title: "Dragon seats",
    group: "Dragon Council",
    description: "How staking a Dragon gives you a Council seat, and what a seat does.",
    content: <>
      <p>A Council seat is a Dragon staked in the Council. Only staked Dragons count: holding one in your wallet does not earn or sit on juries.</p>
      <ul>
        <li><strong>Juries.</strong> A seat can be drawn to judge a challenged result.</li>
        <li><strong>Earnings.</strong> Seats share the Council&apos;s part of market trading fees.</li>
      </ul>
      <p>Stake from the <Link href="/stake">Stake page</Link>: find your Dragon by its number, then stake it. The seat belongs to the account that owned the Dragon. Each account can hold a limited number of seats.</p>
    </>,
  },
  {
    slug: "earnings",
    title: "Earnings and leaving",
    group: "Dragon Council",
    description: "How Council earnings are shared by day and claimed by quarter, and what leaving early costs.",
    content: <>
      <h2>Earning</h2>
      <p>Each time fees arrive, they are split equally among the seats earning at that moment. A seat staked today starts earning tomorrow, UTC, so staking just before fees arrive earns nothing from them.</p>
      <h2>Claiming</h2>
      <p>Earnings are claimed by quarter. A quarter&apos;s earnings become claimable the moment it closes, and they never expire. The running quarter cannot be claimed yet.</p>
      <h2>Leaving</h2>
      <ol>
        <li><strong>Ask to leave.</strong> The seat stops earning and cannot be drawn. You give up half of what it earned in the running quarter. Earlier quarters are paid in full.</li>
        <li><strong>Wait out the cooldown,</strong> then unstake. Your Dragon comes back to your wallet.</li>
      </ol>
      <p>The half you give up is shared among the seats still earning when the quarter closes. A seat serving on an open case cannot leave until the case ends.</p>
    </>,
  },
  {
    slug: "fees",
    title: "Fees",
    group: "Reference",
    description: "Which actions carry a fee on Dragons Market and where fees go.",
    content: <>
      <ul>
        <li><strong>Buying and selling</strong> in a market carry a trade fee, shown in the quote before you trade.</li>
        <li><strong>Price rounds</strong> take a fee only from what the losing side paid. Refunded rounds take none.</li>
        <li><strong>Redeeming, withdrawing and depositing</strong> carry no Dragons Market fee. Your wallet still pays network gas.</li>
      </ul>
      <p>Market fees never come out of a market&apos;s pool, so they never reduce what winners are paid. Part of them goes to the Dragon Council seats.</p>
    </>,
  },
  {
    slug: "open-source",
    title: "Open source",
    group: "Reference",
    description: "Where to read the Dragons Market code and build on it.",
    content: <>
      <p>The contracts, website and backend are public. Read the code and how each contract behaves on <a href="https://github.com/SHC-Labs/DragonsMarket" target="_blank" rel="noreferrer">GitHub</a>.</p>
      <p>To build an AI agent or read market activity, see the <Link href="/api">API</Link>.</p>
    </>,
  },
];
