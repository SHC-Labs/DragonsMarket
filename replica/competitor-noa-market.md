Noa Market (noamarket.xyz), a prediction market already live on NEAR mainnet

Checked 2026-10-15 from the public site, its terms and learn pages, and NEAR mainnet RPC. Anything marked (inferred) is my reading, not stated by them.

What it is. A prediction market on NEAR. Site: noamarket.xyz. Market contract: v3.noamarket.near, owned by the single account noamarket.near. Contract code is 400 KB with 62 exported methods. The parent account was created 2025-04-11. All 16 markets were created between 2026-10-03 and 2026-10-15.

Traction. 16 markets in total: 6 resolved, 2 void, 8 active. Three of the 16 are labeled smoke tests by the team. The biggest volumes are in NPOINT, a token the team calls a play token with no use outside the product, and in small NEAR memecoins (mPoo, a $TEAR token). The top market shows 7 predictors. Real value traded in wNEAR across the two wNEAR markets is about 2 wNEAR in total. Six tokens are whitelisted. Volume in memecoins is large in token units, and I did not price those tokens.

Mechanics. Markets have 2 to 10 outcomes. Each trade moves the price. Their contract fields (b_shares, min_b_shares) point to an LMSR market maker (inferred, not stated). The creator seeds liquidity and gets leftover pool funds back. A creator can cancel before anyone trades.

Fees (read from the contract config). 2% on every buy and sell. Split 50% platform, 40% market creator, 10% resolver. A market creation fee of 0.5 NEAR. Trading fees are not refunded on void.

Resolution. The market creator names a resolver, who cannot be themselves. The official resolver is solver1.noamarket.near. The resolver reports, a dispute window runs (60 minutes for short markets, 24 hours for day markets), then payout opens. The learn page offers no on-platform dispute process: users message the team on X or Telegram. The contract has emergency_resolve and emergency_void, callable by the owner. A market with no result after 30 days voids. A void refunds each user's cost basis minus sale proceeds (the contract tracks get_user_cost_basis), and fees are kept.

Trust and legal. The owner is one account. The contract has a migrate method, so the owner can replace the code. Source metadata links github.com/cuongdcdev/noamarket-monorepo, which returns 404 (private), and there is no reproducible build info. No audit is claimed. The terms name no company or country, call the service "software and information", list no restricted countries, and mention no regulator.

What it means for us.

It answers the open question in spec section 19: yes, another prediction market exists on NEAR. It is two weeks old with almost no real money, so it is a test, not a threat to volume yet.

It does not match what our pitch sells. Its resolver is whoever the creator picks, and the owner can override any result. Ours is a bonded proposal, a public challenge and a drawn jury, with the owner unable to set an outcome. That gap is real, but it is a promise on a page until the Council is built, and a small team that ships a v3 in two weeks can copy a design.

Two things worth copying. The 40% creator fee share gives people a reason to create and promote markets, and it is why the early markets cluster around memecoin communities. A cost-basis refund on void exists and works in production, which is the third option in our open Void decision (AUDIT.md), the one I called much bigger. It needs per-user cost tracking.

One thing to avoid. A flat 2% fee on every trade, with no price shape, is what we decided against.

Not checked. Who runs it. Whether the market maker is really LMSR. What their memecoin volumes are worth. Whether the contract has been audited (no claim found).

Security check on the deployed contract, 2026-10-15

The wasm file at /home/nameless/Downloads/v3.noamarket.near.wasm matches the code hash on v3.noamarket.near (sha256, checked against the live view_account result). Its host imports are the plain NEAR SDK set: storage, promises, sha256, no unusual surface.

Access keys (checked live against mainnet). Every one of their accounts holds exactly one full-access key and nothing else: v3.noamarket.near, noamarket.near, solver1.noamarket.near, treasury.noamarket.near, faucet1.noamarket.near. No multisig. No timelock. One leaked key owns the contract.

The contract exports migrate. Combined with a single full-access key, the owner can replace the running code at any time with no on-chain warning. emergency_resolve and emergency_void let the owner set or void any market's result directly, bypassing the resolver and the dispute window entirely.

contract_source_metadata links github.com/cuongdcdev/noamarket-monorepo, which returns 404. The deployed code cannot be verified against any public source.

What this means for us. contracts/AUDIT.md already names the same gap in our own contracts: no multisig, no timelock, full-access keys still on the deploy accounts. Finding it live in a competitor's mainnet contract is a reason to close it before real money, not a reason to feel ahead. Our oracle has no emergency override path today and the Council design should keep it that way: the only way to a result stays the bonded propose, challenge and jury flow.
