Council NFT research: NEAR standards and how to tie the NFTs to the platform

Written 2026-10-15. Read-only research, nothing built. Facts marked (checked) come from a primary page fetched on that date. Anything marked (unchecked) is from memory or inference and must be verified before it is relied on.

What exists on NEAR for this (checked)

NEP-171 is the core NFT standard. nft_transfer needs 1 yocto and panics unless the caller owns the token or is approved. nft_transfer_call sends the token to a receiver and calls receiver.nft_on_transfer(sender_id, previous_owner_id, token_id, msg). If that returns true the token goes back to the sender, so a receiver that returns false keeps it. If the call fails the NFT contract must revert. The receiver must restrict nft_on_transfer to whitelisted NFT contracts.

NEP-178 approvals let an account move a token for its owner. The standard has no lock or freeze. An owner can always revoke an approval, and approvals do not notify anyone. So a third-party NFT cannot be locked from outside.

NEP-181 adds enumeration views such as nft_supply_for_owner, which is how a contract counts what an account holds. NEP-177 is metadata. NEP-199 is royalties.

NEP-245 is a multi-token standard in one contract, final. We do not need it.

NEP-393 is the soulbound token standard, final. It defines a registry plus issuers, with revoke, renew, recover and a permissionless soul transfer that bans the old account. Token ids are u64 and it must not emit NFT events, so it is not an NFT. It is the standard shape for a non-transferable credential, which makes it a candidate for a one-person-one-credential check against sybil wallets. Which issuers exist on NEAR today is (unchecked).

NEP-641 is final. It defines a view function, w_resolve_auth, that lets a contract attest offchain authorizations without an access key. It could gate Council-only website pages by NFT ownership without a wallet transaction. Not needed for the first build.

near-contract-standards in near-sdk-rs has NonFungibleToken with approval, enumeration and metadata. The impl macros are deprecated, so the traits are implemented by hand and delegate to the inner struct.

Newest NEPs are protocol changes (drafts): NEP-642 makes new accounts about 10x more expensive (status New), NEP-645 adds post-quantum signatures, NEP-646 adds SHA-3 host functions, NEP-652 reassigns chunk producers. None changes the contract design. NEP-642 matters if Intents users need new NEAR accounts, since that cost lands on onboarding.

Randomness. NEAR's docs say the seed comes from the validator's signed previous block hash, so nobody else can predict it, but a validator can still game an input, skip an unfavorable resolve transaction, or frontrun. The docs' answer is a two-stage design: lock the request in one block and read the seed in a later one. That narrows the attack and does not remove it. For us the realistic attacker is a validator who also holds many seats, so panel size, a cap on market size and a bonded jury matter more than the seed.

Shade Agents are not a safe pick. The docs page is titled deprecated and says that after 19 April 2026 the framework is no longer maintained as standalone tooling. It stays open source, with no named successor. An older mirror of the security page calls it experimental with known critical vulnerabilities (unchecked, may be stale). The spec named it as the enclave candidate and has been corrected.

I found no existing NEAR contract for NFT staking with revenue share. Searches returned only validator staking. The pieces below are ours to write.

How the NFTs tie to the platform (proposal)

One rule: the NFT becomes a seat by being staked into a Council registry contract through nft_transfer_call. nft_on_transfer records the seat for the sender, returns false so the registry keeps the token, and accepts only the collection's contract id.

Why custody and not a transfer lock inside the NFT contract. Custody works with any NFT contract, including art minted elsewhere, and needs no change to the collection. It also turns the transfer lock into an unstake delay: unstaking starts a cooldown at least as long as the longest dispute, and a seat drawn for a case cannot unstake until the case ends. The price is that a staked NFT does not show in the holder's wallet and cannot be listed on a marketplace until unstaked. The alternative is our own NFT contract that panics on nft_transfer while the registry marks a token locked. Holders keep the token visible, but it only works for NFTs we mint.

Contracts to add

council-registry. Holds staked NFTs. State per seat: owner, staked_at, unlock_at. Methods: nft_on_transfer (stake), request_unstake, unstake, draw_jury (oracle only), claim. It never has an admin method that moves a token. Honeypot risk: one bug here freezes the whole collection, so it stays small and gets audited alone.

jury draw. Two stages. The oracle calls request_draw when a market is challenged, which stores the block height. Anyone calls resolve_draw at least k blocks later, and the registry picks n distinct accounts by seat, using the seed of that later block mixed with the case id. Drawing per seat, not per account, keeps splitting seats across wallets from raising anyone's odds. Distinct accounts are required because the oracle already needs a unique, odd panel.

oracle changes. challenge becomes a request, the panel is filled by the draw and still snapshotted into the case, and votes become commit then reveal. A juror who does not reveal loses the bond. The oracle already holds a panel of up to 21 accounts, so the voting and majority code mostly stays.

revenue. pm-market takes no fee today. It needs a fee skim on buy and sell, then sends accrued fees to the registry as a fungible-token transfer with a message. The registry keeps an accumulator: acc_per_seat grows by amount divided by staked seats, scaled to avoid rounding loss. Each seat records the accumulator at stake time, so a new staker gets no back pay, and claim pays the difference. With zero staked seats the fees wait. This is the funds-distribution pattern known from Ethereum (unchecked). Only staked seats earn, so earning requires being available to serve. That is a design choice, not a legal answer.

case pay. The oracle sends the loser's bond share to the registry with the list of jurors who revealed and sat with the majority. The registry keeps it in a separate per-account ledger from the revenue share.

AI agent seats. Agents are plain accounts. They do not stake NFTs. The owner (later a multisig with a timelock) keeps a short list of agent accounts that the oracle adds to every panel. How the agents run without the operator reading their keys is OPEN until an enclave route is chosen.

Build order (tracer first)

First slice: the registry with owner-added seats instead of NFTs, the two-stage draw, commit-reveal votes in the oracle, and sandbox tests with time travel. This has value with or without NFTs and tests the hard part. DONE 2026-10-15. pm-council, pm-oracle's resolve_draw/commit_vote/reveal_vote, 8 new sandbox tests, 4 mutation checks passed (2 reverified independently). Found and fixed a real gas-ceiling bug in the first pass: the draw's gas reservation only covered about 250 seats, not the 1,000+ it claimed; now 100 TGas reserved, cap set to 1,000 seats, margin checked at the cap. See contracts/AUDIT.md.

Second slice: nft_on_transfer staking and the unstake cooldown, against the mock NFT from near-contract-standards. DONE 2026-10-15. pm-council now stakes real NEP-171 NFTs via nft_transfer_call, seats belong to the previous owner not the relayer, an unstake cooldown plus a lock-while-serving-on-a-case. New mock-nft crate. 11 new sandbox tests, 4 mutation checks (2 reverified independently by reading the test failure myself). Gas ceiling remeasured for this slice (draw now costs about 190 TGas worst case at 1,000 seats, independently remeasured twice, not carried over from slice 1's smaller number) and the oracle's reservation raised to 250 TGas to match. See contracts/AUDIT.md. Open: a token mid-cooldown can still be drawn, no per-account seat cap, unlock_case has no retry if it fails.

Third slice: fee skim in pm-market and the revenue accumulator. DONE 2026-10-15. p(1-p) trade fee (2% default, no owner setter yet) and a flat creation fee in pm-market; a sweep anyone can call splits collected fees 25/75 to pm-council and a business wallet; pm-council pays revenue only to seats staked when it arrives via a reward-per-share accumulator, equal weight per seat, unstaking pays out first. 18 pm_market + 22 pm_council unit tests, 36 sandbox tests, 5 mutation checks (2 reproduced independently, numbers matched exactly). Independently remeasured the sweep gas floor: 91 TGas, matches the builder's claim to within 0.04 TGas. See contracts/AUDIT.md. All three Council slices are now built and independently verified.

Estimate: about 5 to 8 working days for all three slices with sandbox tests and mutation checks, if the oracle changes stay inside the existing case structure. External audit is separate and required before real money.

Objections that stand

The revenue share on a purchased NFT is the same shape as the revenue-share NFT that Basalt's route list hit in 2026-09-14: the NFT wrapper does not change the securities analysis. The owner chose to take legal later. Nothing here makes it go away, and the whole third slice is the part that depends on it.

Per-seat draws still let a buyer of many seats raise their odds. The cap per buyer and the market size cap are the real controls and are not designed yet.

Open items

Enclave route for agents, SBT issuer for a one-person check, k for the draw delay, cooldown length, seat count and price versus market cap, who owns the registry, and whether the art is minted by our contract or elsewhere.

Owner decisions 2026-10-15

Fees. Every trade pays a fee shaped like Polymarket and Kalshi: rate x shares x p x (1 - p), where p is the average price of the trade. A market also pays a creation fee. A starting rate of 0.02 makes a 50 cent trade cost about 1% of its value and a 97 cent trade about 0.06%. The rate and the creation fee amount are open. Redeem and withdraw carry no fee. Fees collect in one bucket outside any market's collateral. A sweep, callable by anyone, sends 25% to the revenue-share pool and 75% to the business wallet.

Only staked NFTs earn. An unstaked NFT earns nothing and cannot be drawn for a dispute. This keeps the registry as the single source of truth, so the pool never needs the collection's total supply, never calls the collection to check an owner at claim time, and has no back-pay problem if minting continues. It also gives holders a plain reason to stake: staking is how you take part. The boost multiple from the first version is gone, because every staked seat has the same weight.

The pool is an accumulator over staked seats. acc_per_seat grows by amount divided by staked seats, scaled to avoid rounding loss. A seat records the accumulator when it is staked, so a new staker gets no back pay. With zero staked seats the fees wait in the pool.

The quarterly rhythm is a claim cadence. Accounting stays continuous, with sweeps at a fixed interval, so staking the day before a quarter closes does not capture the whole quarter. The unstake cooldown stops a quick in and out.

Revenue belongs to the staker. Unstaking pays out what has accrued first, so an NFT sold after unstaking carries nothing with it.

What is still open. A fixed number of seats is no longer needed for the math. What a staked juror loses for not voting, the cooldown length, the sweep interval, the fee rate and the creation fee amount, and the business wallet being a multisig.

Sizing. The 25% and 75% are set. What they are 25% and 75% of depends on volume nobody has measured, so the first real number comes from the testnet pitch test.
