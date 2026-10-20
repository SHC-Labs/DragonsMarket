Dragons Market: prediction markets with NEAR Intents

Updated 2026-10-19. The accepted custody direction is in [intents-architecture.md](intents-architecture.md). Product goals below are not claims of an already deployed Intents integration. The existing local contract prototype is described in `README.md`; the current delivery scope is in `hackathon-plan.md`.

What it is

A prediction market built on NEAR. Pick a question, buy Yes or No, and sell while trading is open or redeem after the result is final. A winning share pays one collateral unit; it represents $1 only when the chosen collateral and its value support that statement. Users fund through supported cross-chain routes into NEAR Intents, which holds their tokens. Trading commits backing inside Intents under the market's rules, and eligible payouts return to an available Intents balance before withdrawal. Supported assets, conversion, minimums, and fees are shown before funding.

Why anyone would use ours over Kalshi or Polymarket

Both of them work. People use them every day. We read 1,000 recent App Store reviews of the two apps (500 each, from the last 3 to 4 weeks) to see what people actually complain about. Two things stand out, and we can address both because we own the venue.

Slow withdrawals. The earlier review sample recorded 201 of 500 Polymarket reviews and 32 of 499 Kalshi reviews mentioning this problem; those are historical research counts, not a current market-wide measurement. Our target is a visible, recoverable withdrawal through a supported Intents route, with measured completion times. We have not established a minutes-based guarantee. Card and bank holds are separate problems that a crypto payout does not remove.

Rules nobody can read before they bet. 42 Polymarket and 13 Kalshi reviews are about a market settled in a way the user did not expect, from sports bets that were not voided when a player was hurt to price markets with an unclear start date. On ours, the exact rule, the deciding source and what counts as void are written in plain words and locked on-chain before the market opens, so nobody can reword the question after the money is in. Disputes go to the Council, a small jury drawn at random that may not trade that market, with a deadline, and every case is public. The much-discussed UMA token-holder complaint appears only in a few Hacker News comments, not in the app reviews, so we treat it as a supporting point and not the headline.

A third problem is support. 36% of Polymarket reviews say nobody answers when money is stuck. We can promise a person who replies, but that is a staffing cost, not a feature, and we only promise it if we can pay for it.

What we do not claim. Accepting many chains is not special, both rivals already do it. Perps are not special, both have them. Fees came up in only about 2% of reviews, so we do not lead with them. We also do not run bonus or referral schemes: about 176 reviews across the two apps complain of promotions that were not paid. Our edge is trust, and it is only real once people have watched us pay out and resolve fairly for a while.

The Council

Dragon NFTs become Council seats when staked. Eligible seats can be drawn to resolve disputes and accrue the defined share of platform revenue; unstaked NFTs do not earn or serve. The intended payout cadence is quarterly, with accrual, streaming, and claim eligibility specified separately. Intents will hold the corresponding fungible bonds and reward funds in the target design, while the Council keeps staking, eligibility, and reward obligations. The existing code and remaining migration are distinguished in `intents-architecture.md`.

The site uses the professional minimal studio direction, with light/dark themes, shared purple surfaces and mint/forest accents for Council and Membership. Rules, costs, balance states, and dispute progress stay explicit. The four displayed Dragon artworks are a selection from the wider collection, not its total supply.

The existing local test and the next complete demo

The original local prototype exercised a pricing curve and oracle with NEP-141 test collateral. It did not prove Intents custody. The next demo must show:

1. Funding from a supported external chain into a verified Intents balance, then a funded position whose backing remains controlled inside Intents.

2. A market with a fixed rule and source, an optimistic proposal, a challenge, and NFT jurors using commit/reveal to decide. Short demo windows are labeled as demo configuration.

3. A usable website showing actual quotes, positions, fees, available/committed/pending balances, and recoverable transaction status.

4. Redemption, Council fee/reward attribution inside Intents, and a confirmed supported external-chain withdrawal. Simulations and any separately authorized real routing experiments must be identified clearly.

What the test tells us

Whether Intents-held backing and market liabilities reconcile end to end, whether resolution is understandable, and whether users can fund, trade, and exit without hidden balance transitions. Cross-chain funding/custody is now core scope. A new order book and the licensing route remain separate work.

We also read 30 posts and issues from crypto-side users (Reddit, Polymarket's own GitHub, Hacker News). The sample is small and developer-heavy, but it points the same way with a twist: about 16 of 26 describe money that is stuck, late or missing, and most of that is deposits that never arrive and wallet layers that trap funds, not slow withdrawals. So the promise we make is that nothing gets stuck without a visible status and a way out, with fast payouts as one proof of it.

What it costs

Local sandbox tests use test assets. An actual supported bridge/Intents route can require real funds, provider minimums, fees, and deployment/storage costs; testnet does not establish that such a route works. Record measured costs and obtain the product owner's approval before spending or deploying. Delivery milestones and evidence gates are in `hackathon-plan.md`.
