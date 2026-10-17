Prediction market on NEAR: pitch and first test

What it is

A prediction market built on NEAR. You pick a question, say "Will X happen by date Y", and buy Yes or No shares priced between 1 and 99 cents. When the question resolves, each winning share pays $1 and the losing side pays nothing. You can sell any time before that. People join from any chain through NEAR Intents, so a user holding Solana USDC or Bitcoin does not have to bridge anything by hand.

Why anyone would use ours over Kalshi or Polymarket

Both of them work. People use them every day. We read 1,000 recent App Store reviews of the two apps (500 each, from the last 3 to 4 weeks) to see what people actually complain about. Two things stand out, and we can address both because we own the venue.

Slow withdrawals. On Polymarket this is the biggest complaint: 201 of 500 reviews, 40%, and a typical one says it takes days to get winnings out. On Kalshi it is much smaller, 32 of 499, 6%. Ours pays out to your wallet on any chain in minutes through NEAR Intents, shows the status of every withdrawal, and publishes the times it really takes. One honest limit: most of those complaints are about card and bank holds, which a crypto payout does not remove. What we know is that people hate waiting. Crypto-side users complain about something a bit different, covered below.

Rules nobody can read before they bet. 42 Polymarket and 13 Kalshi reviews are about a market settled in a way the user did not expect, from sports bets that were not voided when a player was hurt to price markets with an unclear start date. On ours, the exact rule, the deciding source and what counts as void are written in plain words and locked on-chain before the market opens, so nobody can reword the question after the money is in. Disputes go to the Council, a small jury drawn at random that may not trade that market, with a deadline, and every case is public. The much-discussed UMA token-holder complaint appears only in a few Hacker News comments, not in the app reviews, so we treat it as a supporting point and not the headline.

A third problem is support. 36% of Polymarket reviews say nobody answers when money is stuck. We can promise a person who replies, but that is a staffing cost, not a feature, and we only promise it if we can pay for it.

What we do not claim. Accepting many chains is not special, both rivals already do it. Perps are not special, both have them. Fees came up in only about 2% of reviews, so we do not lead with them. We also do not run bonus or referral schemes: about 176 reviews across the two apps complain of promotions that were not paid. Our edge is trust, and it is only real once people have watched us pay out and resolve fairly for a while.

The Council

The plan, if this pans out, is that the Council is made of holders of an NFT collection whose art already exists and has a dark, cult-like vibe. Jurors are drawn at random for each dispute from active members who have put up a bond, and nobody can buy a seat in the middle of a case. The rules for it are in spec.md section 9. Nothing is minted or sold now, and nothing would be sold until the product runs and the legal questions are answered. When the time comes, the role is announced before any mint and no profit from holding is promised.

The design follows from this. The venue itself stays dark and sober, because what we sell is trust in the referee. The Council gets its own look, a muted violet and a serif face for its seal, juror cards and verdict line, so it reads as a dark order inside the product. Each name has a plain label beside it, so the lore never hides what happened.

The small test

Before anything bigger, one cheap build that shows the core loop works end to end:

1. One market contract on NEAR. It creates a market, lets people buy and sell Yes and No shares against a built-in price curve (so there is always a price, with no order book and no server), and pays out after resolution.

2. A small oracle contract. Someone proposes the outcome with a bond, there is a challenge window, and if nobody challenges it the outcome stands. If someone does, it goes to a test Council of a few accounts we control, shown with the same juror cards the real Council would use. For the test the windows are minutes, not hours.

3. A simple website. It lists markets, shows the rule and the resolution status, connects a NEAR wallet, buys and sells, and redeems winnings.

4. A few NEAR. The test runs on NEAR testnet, which is free. To try it with real money we deploy to mainnet. A contract has to hold NEAR in storage at about 1 NEAR per 100 KB, so a contract of a few hundred KB costs a few NEAR, plus tiny fees. Then a handful of friends trade a market with a few dollars each.

What the test tells us

Whether the market flow works, whether the resolution process is clear to people who have never seen it, and whether the website is something a person can use without help. It does not test the order book, deposits from other chains, or any licence question. Those come after.

We also read 30 posts and issues from crypto-side users (Reddit, Polymarket's own GitHub, Hacker News). The sample is small and developer-heavy, but it points the same way with a twist: about 16 of 26 describe money that is stuck, late or missing, and most of that is deposits that never arrive and wallet layers that trap funds, not slow withdrawals. So the promise we make is that nothing gets stuck without a visible status and a way out, with fast payouts as one proof of it.

What it costs

Testnet: nothing. Mainnet test: a few NEAR for the contract plus a few dollars of play money per tester. The build itself is done here on the machine we already have. The full plan for going further is in spec.md, and the tools we would use are in stack.md.
