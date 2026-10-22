# Dragons Market: contract implementation specs, journeys and build order

**The index to the per-contract specifications, the end-to-end journeys, the call matrix, the requirement coverage, the findings, the build order and the decisions that still need the owner.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Existing behaviour is checked in source. Everything marked PROPOSED is a proposal, not an interface |
| Scope | `contracts/market`, `contracts/oracle`, `contracts/council`, `contracts/upgrade`, the keeper, the DAO owner model and the website adapter layer |
| Source | The whole repository read on 2026-10-21 between 09:00 and 09:45. Requirements are R-01 to R-08 in [docs/spec.md](../../spec.md#requirements-to-implementation-map) |
| Documents | [market.md](market.md), [oracle.md](oracle.md), [council.md](council.md), [owner-and-keeper.md](owner-and-keeper.md), [website-abi.md](website-abi.md) |

---

## Contents

1. [Summary](#1-summary)
2. [How to read these specs](#2-how-to-read-these-specs)
3. [Decisions treated as fixed](#3-decisions-treated-as-fixed)
4. [End-to-end journeys](#4-end-to-end-journeys)
5. [Cross-contract call matrix](#5-cross-contract-call-matrix)
6. [Requirements and current coverage](#6-requirements-and-current-coverage)
7. [Findings from comparing docs, code and website](#7-findings-from-comparing-docs-code-and-website)
8. [Build order](#8-build-order)
9. [Open decisions](#9-open-decisions)
10. [Decisions for the owner](#10-decisions-for-the-owner)
11. [Unverified or assumed](#11-unverified-or-assumed)
12. [Evidence and limits](#12-evidence-and-limits)

---

## 1. Summary

The market and the Council already keep their money in their own accounts inside the NEAR Intents verifier. Money arrives by `mt_transfer_call`, leaves by `mt_transfer`, and neither contract registers a key in the verifier. The market splits fees 25% and 75% and sends each leg independently. These parts are in the working tree, uncommitted, and are being finished by phase I2.

Four things stand between this code and the accepted product.

| Remaining work | Why it matters | Size (estimate, not a commitment) |
| --- | --- | --- |
| The oracle still takes bonds as a NEP-141 token and pays them with `ft_transfer` | R-06 is not met. Bonds and juror pay are the last money outside Intents | 1.5 to 2 working days |
| The Council has a 30-day reward stream, not quarterly claims | R-05 is missing. Holders cannot claim a quarter. Section 6 of [council.md](council.md#6-the-quarterly-accounting-proposal) is a concrete proposal | 3 to 4 working days |
| The market has no record of pending withdrawals or fee legs, and a lost Council result can be settled only by trusting the owner | R-02, R-03 and R-08 ask for recoverable, visible operations | 2 working days |
| The DAO tooling is a deny-list of five names, the keeper does no reconciliation, and the website still sends the old NEP-141 transfer | R-07 and R-08, and the website cannot fund or buy at all against the current market | 1.5 days for the keeper and DAO helper, about 4 days for the website |

DECIDED (owner, 2026-10-21): SputnikDAO owns the contracts and its voting period is the only delay. No enforced delay after approval will be built. SputnikDAO executes a proposal in the same call as the approval that reaches the threshold, so the voting period is public visibility plus a deadline, not a delay after approval. The product documents that required a 72-hour delay after approval were rewritten to this decision on the same day (finding F-02). [owner-and-keeper.md](owner-and-keeper.md#2-the-owner-model) says what the policy should be.

The biggest gaps between documents, code and website:

1. The oracle's custody (F-01).
2. The product documents required a 72-hour enforced delay that SputnikDAO cannot give. The owner decided against it and the documents now say so (F-02, DECIDED).
3. The treasury helper would let a member approve most dangerous proposal kinds (F-03).
4. The website's buy, challenge and balance code cannot work against the current contracts (F-04, F-05, F-06).
5. A user without a NEAR wallet cannot call `sell`, `redeem` or `withdraw` (F-11).

---

## 2. How to read these specs

### 2.1 The files

| File | Contents |
| --- | --- |
| README.md | This index: journeys, call matrix, requirement coverage, findings, build order, decisions |
| [market.md](market.md) | Market purpose, state, grammar, every method, required changes, views, events, invariants, errors, tests |
| [oracle.md](oracle.md) | The same for the oracle, with the Intents bond migration |
| [council.md](council.md) | The same for the Council, with the quarterly accounting proposal and worked examples |
| [owner-and-keeper.md](owner-and-keeper.md) | Owner and operator methods, DAO proposals, the allow-list, DAO policy, the keeper |
| [website-abi.md](website-abi.md) | Views, calls, messages, gas, errors and enums for web types, and where `web/lib` differs |

### 2.2 Labels

| Label | Meaning |
| --- | --- |
| DECIDED | An owner instruction. Treated as fixed. Matches "Owner choice" in [DOCUMENTATION-STYLE.md](../../DOCUMENTATION-STYLE.md#3-evidence-and-status) |
| PROPOSED | Proposed in these documents. Matches "Decision pending" |
| OPEN | A choice nobody has made. Each has a recommended default in section 9 |
| BUILT, PARTIAL, MISSING | Coverage of a requirement in the code today |
| EXISTING, CHANGED, NEW | A method or field that exists, exists and must change, or does not exist |
| Checked in source | The file was read. The file and line are given. Runtime behaviour may still be untested |
| Test exists, not run | A named test is in the repository. It was not run in this task |
| Verified by run | A command ran in this task and the result is stated |
| Reported externally | An outside review or document states it. This task did not reproduce it |
| UNVERIFIED | Not checked. Said out loud so nobody reads it as checked |

### 2.3 Revision checked

The repository is at commit `6cad02e` with a dirty working tree. Phase I2 (market and Council on Intents and their manuals) is editing files while these specs were written. Another session changed the docs, the keeper and removed the custom governance contract. Where code and a document disagree, the code is right and the gap is a finding.

| File | sha256 prefix at last comparison | Lines | Notes |
| --- | --- | --- | --- |
| `contracts/market/src/lib.rs` | `6bed015aa459a237` | 4122 | Changed during reading: a length check added at 09:11, a halt text flipped at 09:21 and back at 09:37 |
| `contracts/council/src/lib.rs` | `cc840f4fdbe5caf9` | 2510 | Unchanged from 09:04 |
| `contracts/oracle/src/lib.rs` | `ec8878d63390ecf8` | 3586 | Unchanged from 08:44. 15 lines differ from `HEAD` |
| `contracts/upgrade/src/lib.rs` | `929578cc91804b39` | 238 | Unchanged |

Line numbers in the specs are for these copies. If I2 edits the files again, the line numbers in `market.md` can move by a few lines after line 727. The web files cited were last modified on 19 and 20 October, except two page files another session touched at 09:28 that these specs do not cite.

The product documents changed while these specs were written. `docs/spec.md` was replaced at 09:24 by a 309-line version, and `intents-architecture.md`, `hackathon-plan.md`, `DEPLOY.md`, `governance.md`, `README.md` and `PITCH.md` were rewritten between 09:07 and 09:30. The line numbers cited for them are for the versions read after 09:30. The previous `docs/spec.md` (1199 lines) is no longer on disk. Its text at commit `6cad02e` is `git show 6cad02e:spec.md`, and this document calls it the previous spec.

### 2.4 What was run

| Command or action | Result |
| --- | --- |
| `node --test keeper/keeper.test.mjs keeper/treasury.test.mjs` | 23 passed, 0 failed. Verified by run |
| A probe script that imports `treasury.mjs` and feeds it eight administrative methods and ten proposal kinds | Showed the deny-list gaps in finding F-03. Verified by run |
| Fetching `sputnikdao2/src/proposals.rs`, `policy.rs`, `types.rs` and `views.rs` at revision `5434a59dec23ee0c49df8c8c4350c208a7e75b0b` | Read as data. Used in [owner-and-keeper.md](owner-and-keeper.md) |
| `cargo` unit tests, the sandbox suite, the web tests | Not run. I2 is building in the same tree, and the sandbox needs the verifier wasm |

---

## 3. Decisions treated as fixed

All DECIDED, from [docs/spec.md](../../spec.md#6-collateral-and-custody) sections 6, 7 and 10, [docs/intents-architecture.md](../../intents-architecture.md) and the owner's instructions for this task.

| Decision | Statement |
| --- | --- |
| Collateral | Native USDC only. Intents token id `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, six decimals. Any other deposit asset is converted to USDC by 1Click at the Intents edge before it reaches a contract |
| Withdrawals | Pay USDC. The user bears the withdrawal and swap fee |
| Custody | NEAR Intents, verifier `intents.near` version 0.4.5. The market, oracle and Council each keep funds in their own Intents account, receive through `mt_on_transfer` and pay through cross-contract `mt_transfer` or `mt_transfer_call`. Proved in [INTENTS-PROOF.md](../INTENTS-PROOF.md) |
| Governance | The custom governance contract is retired. Trezu and SputnikDAO own the market, oracle and Council. The owner is only an `AccountId`. No contract may call, depend on or name a governance contract. The DAO's only delay is its voting period (owner decision, 2026-10-21) |
| Revenue | Earned platform fees: 75% to the Trezu project treasury (account configured by the owner, not yet known), 25% to Council-controlled reward backing held in Intents |
| Holder rewards | Eligible NFT holders claim quarterly. Each entitlement is claimable once through Council-authorised Intents settlement |
| Separation | Juror pay and dispute bonds stay separate from holder revenue |
| NFT staking | NEP-171 stays |
| Upgrades | `stage_code`, `upgrade`, `migrate`, `seal` and `upgrade_in_flight` stay |
| Review fixes | C-01 to C-21 and N-01 to N-10 stay in force ([AUDIT.md](../AUDIT.md#every-finding-and-where-it-went)) |

**Resolved conflict with the product documents.** Until 2026-10-21, `docs/spec.md` and other product documents (finding F-02) required a minimum 72-hour enforced delay after approval and permitted a focused delay component. The owner decided on 2026-10-21 that the voting period is the only delay, and those documents were rewritten to match. No timelock account will be built. Every contract treats the owner as an `AccountId`, so nothing in this folder changed.

---

## 4. End-to-end journeys

Columns: who acts, which method, which verifier calls, which events, what happens on failure, and whether it is built. Event names are the contract's own. M is the market's Intents account, O the oracle's, C the Council's, U the user's, T the treasury's.

### J0. Register once

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | User, or anyone paying for the user | `market.storage_deposit({})` with 0.05 NEAR | none | `registered` | Less than 0.05 NEAR is refused and returned. A surplus goes back to the payer. An account already registered gets all of it back | BUILT |

### J1. Fund through 1Click, then `mt_transfer_call` into the market

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Website | 1Click quote. Destination asset is the USDC token id. Recipient is the user's NEAR account as an Intents account. A refund address is on the origin chain | none | none | A quote that is not paid expires. A failed swap is refunded by the provider to the refund address | OPEN. UNVERIFIED: whether a recipient type of Intents credits the user's Intents account (the previous spec listed it as still to be measured) |
| 2 | User | Pays the origin asset to the deposit address the quote returns | The bridge or provider credits U inside the verifier | none from our contracts | Provider refund path | UNVERIFIED |
| 3 | Website | Reads `verifier.mt_balance_of(U, token)` until it rises | view | none | A provider status or a browser claim is never credit | Website MISSING |
| 4 | User | `verifier.mt_transfer_call(receiver_id=market, token_id, amount, msg="deposit")`, 1 yocto, 100 TGas | The verifier moves the amount from U to M, then calls `market.mt_on_transfer(sender=U, previous_owner_ids=[U], ...)` | `deposit` | A refusal panics. The verifier refunds U in full and returns `["0"]`. Reasons: not registered, paused, wrong token, other owner | BUILT. Tests `intents_market.rs:54`, `:150`, `:189` exist, not run |
| 5 | Website | Reads `market.get_balance(U)` | none | none | If both balances are unchanged the call was refused. Read the panic text | Website MISSING |

A plain deposit to the market's own account, in any message form, credits M and calls nothing. It is surplus that nobody is credited for (`intents_market.rs:382`).

### J2. Buy

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1, direct | User | `verifier.mt_transfer_call(market, token, amount, msg="buy:<id>:<yes\|no>:<min_shares>")` | As J1 step 4 | `buy` | Refund in full if the market is not open, the price moved past `min_shares`, the position cap is hit or the sender is not registered | BUILT |
| 1, from balance | User | `market.buy(market_id, side, amount, min_shares)`, 1 yocto | none | `buy` | The debit and the trade are one receipt, so a refusal restores the balance | BUILT |
| 2 | Market | Takes the fee, moves the rest into the market's `locked`, issues shares | none, the money is already in M | none | none | BUILT |

### J3. Sell

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | User | `market.sell(market_id, side, collateral_out, max_shares_in)`, 1 yocto. Use `quote_sell` first | none | `sell` | `price moved, would need more shares than your maximum` reverts. The market must be open and not halted | BUILT |
| 2 | Market | Removes shares, takes the fee, credits `collateral_out - fee` to the internal balance | none | none | none | BUILT |

Proceeds are in the internal balance. They reach U only through `withdraw` (J6).

### J4. Dispute from proposal to payout

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Proposer | After close: bond to the oracle with `propose:<id>:<outcome>:<evidence>`. For a price market `price:<id>:<price>:<signatures>` | Target: `verifier.mt_transfer_call(oracle, ...)`. Today: `ft_transfer_call` on the token | `proposed` | Panic returns the bond. Refused: market not closed, too late for both rounds, a case already exists | Rules BUILT. Intents custody MISSING (R-06) |
| 2 | Challenger | Within the window: `challenge:<id>:<answer>` with an equal bond. The answer must differ from the proposal | same | `challenged` | Panic returns the bond | Rules BUILT. Intents custody MISSING |
| 3 | Anyone | `oracle.resolve_draw(id)`, at least 275 TGas, from `draw_after_height` to `draw_by` | none. The oracle calls `council.draw` | `jury_drawn` or `draw_failed` | A failed draw changes nothing and can be retried until `draw_by` | BUILT |
| 4 | Each juror | `oracle.commit_vote(id, commitment)`, 1 yocto, before `commit_ends_at` | none | `vote_committed` | Not on the panel, phase over, malformed commitment: refused | BUILT |
| 5 | Each juror | `oracle.reveal_vote(id, outcome, salt, reason)`, 1 yocto, at least 80 TGas, after `commit_ends_at` and by `panel_deadline` | none | `vote_revealed`, then `final` and `outcome_applied` when a majority settles | A vote that does not match the commitment or names a third answer is refused | BUILT |
| 6 | Anyone | `oracle.finalize(id)` after the window (unchallenged) or after the round (disputed) | none | `final` or `escalated` | A first round without a majority is followed by one larger jury of 2n+1, at most 21, if time allows | BUILT |
| 7 | Anyone | `oracle.resolve_by_deadline(id)` after `resolve_by` | none | `final`, `deadline_void` | Refuses a case that still has time | BUILT |
| 8 | Oracle | `settle` credits bonds to `claimable`, sends `set_outcome` to the market and `unlock_case` to the Council | none | `final` | `retry_apply` and `retry_unlock` repeat the two calls | BUILT |
| 9 | Winners, jurors, recipient | `oracle.withdraw_bond()`, 1 yocto. NEW `payout_bond(account)` lets anyone push it | Target: `mt_transfer` from O. Today: `ft_transfer` | NEW `bond_paid` | A failed payout restores `claimable` | Intents payout MISSING |

### J5. Redeem

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Holder | `market.redeem(market_id)` after the outcome. Yes pays 1 per Yes share, No pays 1 per No share, Void pays the closing price | none | `redeemed` | `nothing to redeem`. Works while paused or halted | BUILT |
| 2 | Operator or owner | `claim_residual(market_id)` | none | `residual_claimed` | Today the residual lands in the treasury's internal balance. CHANGED: it joins the treasury leg | PARTIAL |

### J6. Withdraw to Intents and exit

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | User | `market.withdraw(amount)`, 1 yocto | `mt_transfer(U, token, amount)` from M, 15 TGas reserved | `withdraw`, then `withdraw_failed` on error | The balance is debited first and restored in `on_withdraw` if the verifier refused. Nothing moves on an error | BUILT. Pending record and `withdraw_confirmed` are NEW |
| 2 | User | Signs an Intents withdrawal or a 1Click swap from U to an external address | Outside the contracts | none | The provider's own refund path | UNVERIFIED. The user pays the fee (DECIDED) |

### J7. Fee sweep with the 75% and 25% split

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Anyone or the keeper | `market.sweep_fees()`, at least 87 TGas. The keeper also sweeps shortly before each quarter boundary | none | `fees_swept` | Below the floor: refused with the amount. Below `min_sweep` (NEW): nothing happens | BUILT. Sweep ids NEW |
| 2 | Market | `council = floor(total * 25%)`, `treasury = floor(total * 75%)`, remainder 0 or 1 unit stays in `fees`. Records both before sending | none | none | none | BUILT. Record NEW |
| 3 | Market | Council leg: `mt_transfer_call(council, token, amount, msg="revenue")`. NEW message `revenue:<sweep_id>` | verifier, then `council.mt_on_transfer` | `revenue` (Council) | A Council panic is refunded by the verifier. The amount returns to `revenue_due` (`fee_transfer_failed`). A lost result parks it in `revenue_unresolved` (`fee_transfer_unresolved`) | BUILT. Council dedupe and `settle_leg` NEW |
| 4 | Market | Treasury leg: `mt_transfer(treasury, token, amount)` | verifier | none | An error restores `business_due`. The other leg is untouched | BUILT |
| 5 | Anyone | NEW `settle_leg(sweep_id)` for a leg that stayed unresolved | none | `fee_leg_settled` | Reads the Council's `received_of`. A record settles it, no record makes it due again | NEW |

Worked rounding: 1,095,193 units gives 273,798 to the Council, 821,394 to the treasury and 1 left in `fees` (sandbox test `gas_floors.rs:296-318`).

### J8. Stake a seat, serve, and claim quarterly

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Holder | `nft.nft_transfer_call(council, token_id, msg="")`, 1 yocto | none | `staked` | A token off the allowlist, a staked token, a full council or a capped account panics, so the NFT returns | BUILT |
| 2 | Oracle | `council.draw` seats a jury and `unlock_case` releases it. A juror who never votes forfeits the seat time of the serving span | none | NEW `seat_time_forfeited` | Today the forfeit is stream revenue | BUILT today, CHANGED |
| 3 | Council | Revenue from J7 step 3 is credited to the quarter of the receipt | none | `revenue` with `quarter` | A repeated sweep id or another sender is refused and refunded | NEW |
| 4 | Anyone | `council.finalize_quarter(q)` once `now >= ends_at + close_grace` | none | `quarter_finalized` | Quarters finalize in order | NEW |
| 5 | Seat owner | `council.claim_quarter(q, token_id)`, 1 yocto, 100 TGas | `mt_transfer(owner, token, amount)` from C | `claim_requested`, `claim_paid` | An error deletes the pending record. `claim_failed`. The owner claims again | NEW (R-05 MISSING today) |
| 6 | Seat owner | `request_unstake`, then `unstake` after the cooldown. Unstake returns the NFT and no money | none | `unstake_requested`, `unstaked` | A failed NFT transfer restores the stake | BUILT, CHANGED to stop paying |

### J9. Owner administration through the DAO

| Step | Caller | Method | Verifier calls | Events | Failure and refund | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Proposer | `dao.add_proposal({proposal: {description, kind: FunctionCall{...}}})` with a deposit equal to the policy bond | none | DAO log | A wrong bond panics `ERR_MIN_BOND` | Helper PARTIAL: deny-list only |
| 2 | Members | `dao.act_proposal(id, "VoteApprove", kind, memo)` | none | DAO log | `ERR_WRONG_KIND` if the kind differs from the stored one | Helper PARTIAL |
| 3 | DAO | The approval that reaches the threshold executes the call in the same transaction | none | The contract's own event, for example `fee_rate_set` | A failing call marks the proposal `Failed`. `Finalize` retries it before the period ends. After the period it can no longer be approved | Sputnik behaviour, Checked in source at the pinned revision |
| 4 | Anyone | Read `config` on the contract | none | none | none | BUILT |

Handover: `propose_owner(dao)` by the old owner, then the DAO runs `accept_owner`. Steps in [owner-and-keeper.md](owner-and-keeper.md#8-handover-checklist).

---

## 5. Cross-contract call matrix

Gas is what the caller reserves for the call. Source lines are the 09:22 to 09:38 copies.

| From | To | Method | Used by | Gas reserved | Callback | Status |
| --- | --- | --- | --- | --- | --- | --- |
| market | verifier | `mt_transfer` | `withdraw`, treasury leg | 15 | `on_withdraw`, `on_business_sent` 10 | BUILT (`market lib.rs:53`, `:872`, `:952`) |
| market | verifier | `mt_transfer_call` | Council leg | 42 (22 verifier overhead plus 20 Council receipt) | `on_revenue_sent` 10 | BUILT (`:56-58`, `:933`). The Council receipt reserve needs measuring after the quarterly change |
| market | oracle | `register_market` | `create_market`, `retry_register` | 20 | `on_registered` 10 | BUILT (`:59`) |
| market | council | `received_of` | NEW `settle_leg` | 10 | callback 10 | NEW |
| verifier | market | `mt_on_transfer` | funding, buy, seed | attached minus about 20.5 | none | BUILT |
| verifier | council | `mt_on_transfer` | revenue | attached minus about 20.5 | none | BUILT |
| verifier | oracle | `mt_on_transfer` | bonds | attached minus about 20.5 | none | NEW |
| oracle | market | `set_outcome` | `settle`, `resolve_by_deadline`, `retry_apply` | 20 | `on_applied` 10 | BUILT (`oracle lib.rs:18`, `:1252`) |
| oracle | council | `draw` | `resolve_draw` | 250 (floor 275 attached) | `on_drawn` 15 | BUILT (`:21-22`, `:684`) |
| oracle | council | `unlock_case` | `settle`, `retry_unlock` | 15 for each jury | none | BUILT (`:25`, `:1266`) |
| oracle | verifier | `mt_transfer` | NEW `withdraw_bond`, `payout_bond` | 15 | `on_bond_paid` 10 | NEW |
| council | verifier | `mt_transfer` | NEW `claim_quarter`. Today `claim` and `unstake` | 15 | `on_claim_paid` 10. Today `on_unstake_paid` 35 reserved | BUILT today, CHANGED (`council lib.rs:32-44`, `:835`) |
| council | NFT contract | `nft_transfer` | `unstake` | 15 | `on_unstaked` 10 | BUILT (`:30`, `:842`) |
| NFT contract | council | `nft_on_transfer` | staking | n/a | none | BUILT (`:735`) |
| DAO | market, oracle, council | owner methods | J9 | 30 for setters, 100 or more for `upgrade` | none | Sputnik, not run in the sandbox |
| anyone | each contract | `upgrade` then `migrate` | upgrades | 100 attached, 30 for `migrate` | none | BUILT (`upgrade/src/lib.rs:17-20`) |
| keeper | oracle, market, council | public methods | section 9 of the keeper spec | 30 to 300 | none | BUILT for oracle and market. Council methods NEW |

Rules the matrix keeps. The verifier is asked only to transfer (`guards.rs:253`). No contract calls a verifier admin method (`guards.rs:265`). The oracle's `ext_ft` entry in `EXPECTED_EXTERNAL_INTERFACES` (`guards.rs:48`) must change with the oracle migration.

---

## 6. Requirements and current coverage

| Req | Required capability | Methods | Coverage | Evidence | Gap |
| --- | --- | --- | --- | --- | --- |
| R-01 | Bind funding to the right user and commit backing inside Intents before issuing positions | `market.mt_on_transfer` (`market lib.rs:715-780`), NEP-145 registration | PARTIAL | Checks: caller is the verifier, one token, token id, `previous_owner_ids == [sender]`. Tests `intents_market.rs:150`, `:189`, `:270`, `:382` exist | Real USDC never run. A user without a NEAR wallet cannot sell, redeem or withdraw (F-11). The keeper does not check that no key is registered. The verifier's own admin roles can freeze or move funds, a trust assumption |
| R-02 | Buy, sell, redeem and release only what is owed, with recoverable pending operations | `buy`, `sell`, `redeem`, `withdraw`, `on_withdraw` (`:787-905`) | PARTIAL | `intents_market.rs:54`, `:436`, `:480`, `attacks.rs:646` exist | No pending withdrawal record or view. Recoverable only by restoring on error |
| R-03 | Collect fees and allocate 75% and 25% without spending backing, with exact rounding, independent legs, safe retry and verified destinations | `sweep_fees`, `on_revenue_sent`, `reconcile_revenue`, `on_business_sent` (`:913-1021`) | PARTIAL | Split, rounding and legs: unit `lib.rs:1858`, `:3427-3603`, `revenue.rs:95`, `hardening.rs:500`, `:606` exist | Sweep ids, leg statuses, Council dedupe, `settle_leg`, treasury account not known and not verified |
| R-04 | Preserve NFT eligibility, jury selection, case obligations and entitlement records | `nft_on_transfer`, `draw`, `unlock_case` (`council lib.rs:440-491`, `:735`) | PARTIAL | `staking.rs`, `council.rs`, `hardening.rs:267-433` exist | Entitlement records do not exist (R-05) |
| R-05 | Account for earnings by quarter, each entitlement claimable once through Council-authorised settlement | none | MISSING | The 30-day stream is `council lib.rs:26-29`, `:93-160`, `:576-605` | All of [council.md](council.md#6-the-quarterly-accounting-proposal) |
| R-06 | Settle bonds and juror pay separately from holder revenue | `settle` (`oracle lib.rs:1179-1250`), `ft_on_transfer` (`:645`), `withdraw_bond` (`:915`) | PARTIAL | Payout math and tests exist (`juror_pay.rs`, unit `oracle lib.rs:1572`) | Custody is NEP-141, not Intents (F-01) |
| R-07 | Use Trezu/Sputnik member approvals for sensitive administration, with the DAO voting period as the only delay (DECIDED 2026-10-21). Evidence: restricted methods, owner handover, upgrades, key-bypass checks. No custom governance | owner checks, `propose_owner`, `accept_owner`, `upgrade`, `seal` | PARTIAL | Owner is an `AccountId` (`guards.rs:151`, `:179`). Owner fixture tests `upgrade.rs:130` | No test with a real DAO. The helper is a deny-list that refuses `upgrade`, `seal` and the owner handover (F-03) |
| R-08 | Views, events and services that show available, committed, pending, accrued, claimable, paid and quarter state | `get_balance`, `get_shares`, `get_fees`, `total_owed`, `config`, `get_case`, `claimable_of`, `pending_reward` | PARTIAL | Existing views listed in each spec | No account view, position list, pending state, quarter views, reconciliation views or case list. Several events fire before the transfer is known to have worked (F-14) |

---

## 7. Findings from comparing docs, code and website

The code is right where it disagrees with a document. Each finding names the fix.

| ID | Finding | Evidence | Effect | Action |
| --- | --- | --- | --- | --- |
| F-01 | The oracle still takes bonds as a NEP-141 transfer and the source guard and test harness pin that | `oracle lib.rs:17`, `:194-197`, `:228`, `:645`, `:915-931`. `guards.rs:48`. `common/mod.rs:331-339` | R-06 is not met. Bonds are the last money outside Intents | [oracle.md](oracle.md#8-methods-and-changes-required) |
| F-02 | DECIDED 2026-10-21. Product documents required a minimum 72-hour delay after approval and allowed a focused delay component. The DAO executes at approval (Sputnik `proposals.rs:638-643`), and the owner decided that the voting period is the only delay | Before the rewrite: `spec.md` section 7 and R-07, `intents-architecture.md` (Trezu administration), `DEPLOY.md` section 3, `governance.md`, `README.md`, `PITCH.md`, `hackathon-plan.md` | A reader believed users got an exit window that nothing provides | Done: those documents were rewritten to the decision on 2026-10-21. The helper's delay-based refusals remain in code until the allow-list replaces them (F-03) |
| F-03 | `treasury.mjs` is a deny-list of five names. A run prepared `set_operator`, `set_fee_rate_bps`, `set_nft_contract`, `add_publisher` and `set_no_decision_recipient`. The vote helper blocks 3 of 17 proposal kinds. It refuses `upgrade`, so no upgrade can be prepared | `treasury.mjs:4`, `:33-35`, `:71-74`. Probe run in this task | A member using the helper can approve membership and policy changes unchecked | [owner-and-keeper.md section 5](owner-and-keeper.md#5-the-allow-list-that-replaces-the-deny-list) |
| F-04 | The website's buy builder sends `ft_transfer_call` to the token. The market has no `ft_on_transfer` | `web/lib/market.ts:126-132`, `:142-143`. `market lib.rs:715` | A buy would be a plain token transfer to the market account, which has no handler | Verifier `mt_transfer_call` builder ([website-abi.md](website-abi.md#5-market-calls-and-messages)) |
| F-05 | The challenge message has no answer | `market.ts:172`. `oracle lib.rs:674` | The oracle panics `outcome must be yes, no or void` | Add `:<answer>` |
| F-06 | The site reads free funds from the NEP-141 token and has no verifier, Council or collateral id in its configuration | `market.ts:100`. `config.ts:15-27`. `portfolio/page.tsx:77` | Wrong balance after the change. No way to reach the Council | [website-abi.md section 2](website-abi.md#2-configuration-the-site-needs) |
| F-07 | The sweep gas floor is stale in two comments. The code is 87 and a test asserts 87. Comments and the audit say 95 | `market lib.rs:910-912` (comment), `:64-66` (code). `keeper.mjs:56`. `gas_floors.rs:296-306`. `AUDIT.md` Phase 3 | None, 100 TGas still clears it | Fix the comments |
| F-08 | The verifier proof says the keeper should read `is_account_locked` and stop advertising funding while the market is locked. The keeper has no such code | `INTENTS-PROOF.md:182-184`. `keeper.mjs` (no `is_account_locked`, `mt_balance_of` or `public_keys_of`) | A locked market keeps taking deposits it cannot pay out | [owner-and-keeper.md section 9](owner-and-keeper.md#9-the-keeper) |
| F-09 | `AUDIT.md` stops at phase I1. It cites moved paths (`contracts/INTENTS-PROOF.md`, `pm-*.md`, governance) and names a reviewer in its second review header. `AUDIT.md` also describes the verifier tests as skipping when the wasm is missing, while the harness now fails with the recipe (`INTENTS-PROOF.md:81` already says so) | `AUDIT.md:1729`, `:1902`, `:1911`. `common/mod.rs:53-70` | No dated entry records the I2 migration. A reader follows an old instruction | Add dated I2 and I3 entries when they land. Keep the review text unchanged |
| F-10 | `claim_residual` credits the treasury's internal balance, and the oracle's no-decision share and juror pay wait in `claimable`. A DAO treasury must pass a proposal to collect either | `market lib.rs:651-669`. `oracle lib.rs:915-931` | Routine revenue depends on a vote | [market.md 7.3](market.md#73-residual-and-treasury-payments-r-03), [oracle.md 8.2](oracle.md#82-payouts-r-06) |
| F-11 | `sell`, `redeem` and `withdraw` use the NEAR caller. A user who funds from another chain and has only an Intents account has no NEAR account to call them from | `market lib.rs:796`, `:839`, `:872` | R-01 identity binding works only for NEAR wallet users | OD-10 |
| F-12 | Phase I2 is mid-edit. A length check was added at 09:11, a halt message flipped to `governance action` at 09:21 and back to `an owner action` at 09:37. The guard forbids the word in strings | `market lib.rs:594`, `:727-730`. `guards.rs:179-191` | The guard would have failed at 09:21 | I2 confirms the frozen build |
| F-13 | `total_owed` walks every market | `market lib.rs:1056-1062` | The keeper's reconciliation grows with market count. View gas not measured | [market.md 7.5](market.md#75-reconciliation-views-r-08) |
| F-14 | Several events fire before their transfer is known. `withdraw`, Council `revenue_claimed`. `set_nft_contract` and `set_jury_size` emit nothing | `market lib.rs:872-891`. `council lib.rs:596-599`, `:387-394`. `oracle lib.rs:532-536` | An indexer would show a payment that later failed | Rename or add confirm events |
| F-15 | The website fans out one RPC per market | `portfolio/page.tsx:36-43`. `council/view.tsx:13-18` | RPC load grows with market count | `get_positions`, `list_cases` |
| F-16 | The sandbox owner fixture is an ordinary account | `common/mod.rs:882-889` | R-07 has no test with a DAO | Sandbox with a real SputnikDAO build |
| F-17 | The CI workflow is uncommitted and has never run on GitHub. It builds the verifier with Docker and checks its hash. It has no reproducible build job for the three contracts and no web job | `.github/workflows/ci.yml:100-108`. `AUDIT.md` C-21 row | The first push may fail for reasons nobody has seen | Run it once, add the missing jobs |

---

## 8. Build order

Done and in flight come first. Estimates are working days for one person and are guesses. They assume the interface in these specs is frozen before work starts. The hackathon plan orders delivery as gates A to F without dates ([hackathon-plan.md](../../hackathon-plan.md#2-delivery-order)). Gate A (account model, interfaces, quarter rules) is what these specs propose. P1 and P3 serve gate B, P2 and P4 serve gate C, P5 serves gate D, and P8 serves gate E.

| Phase | Work | Depends on | Estimate | Closes |
| --- | --- | --- | --- | --- |
| P0 done | Intents verifier proof (I1). Source guards. Keeper basics. CI draft. Review fixes C-01 to C-21, N-01 to N-10 | none | done | Reported in AUDIT.md |
| P1 in flight (I2) | Market and Council on Intents with manuals and tests. Freeze the build: resolve finding F-12, run all suites, add an AUDIT entry | none | 0.5 | R-01 partly, R-03 partly |
| P2 bonds (I3) | Oracle on Intents: `mt_on_transfer`, verifier payouts, `payout_bond`, bond totals, `list_cases`, guard and harness change ([oracle.md](oracle.md)) | P1 | 1.5 to 2 | R-06 |
| P3 market ledger (I4) | Sweep ids and leg records, `settle_leg`, pending withdrawals, positions and account views, residual onto the treasury leg, rename to treasury, O(1) `total_owed` ([market.md](market.md)) | P1 | 2 | R-02, R-03, R-08 |
| P4 quarterly claims (I5) | Quarter books, seat weights, forfeits as weight, claim records, sweep id dedupe, revenue only from the market, removal of the stream ([council.md](council.md)) | P1, and the message `revenue:<sweep_id>` from P3 | 3 to 4 | R-04, R-05 |
| P5 owner tooling | Allow-list helper, vote checks for all 17 kinds, DAO sandbox with a real SputnikDAO build, policy test ([owner-and-keeper.md](owner-and-keeper.md)) | none | 1.5 | R-07 |
| P6 keeper | Reconciliation for M, O and C, verifier health, DAO watcher, quarter calls, status file, exit codes | P2, P3, P4 views | 1.5 | R-08 |
| P7 CI and builds | Run the workflow on GitHub, add the reproducible build with hash record for the three contracts, a guards job, a web typecheck job | P1 | 0.5 | C-11, C-21 |
| P8 website | Generate types from [website-abi.md](website-abi.md), new configuration, verifier funding and buy builders, positions and list views, quarter claim screens, error copy, enable writes | P2, P3, P4 interface | about 4 | R-08 in the UI |
| P9 evidence | Testnet DAO with the sandbox verifier (the verifier has no testnet). A capped mainnet run with real USDC and a measured 1Click route. Measure the gas figures marked UNVERIFIED | all | 2 | Remaining UNVERIFIED items |

P2, P3 and P4 touch different contracts and can run in parallel once the message `revenue:<sweep_id>` and the view shapes are frozen. P4 is the largest and has the most new logic. Critical path: P1, then P4, then P6 and P8.

---

## 9. Open decisions

Each has a recommended default. A default is what to build if the owner does not answer. Items marked "needed" block a phase.

| ID | Decision | Options | Recommended default | Needed by |
| --- | --- | --- | --- | --- |
| OD-01 | DECIDED 2026-10-21. Enforced delay for owner actions | None, only the voting period. A minimal timelock account as owner | Decided: none. The voting period is the only delay, and no timelock account will be built. Cap value at launch. The documents that promised a delay were rewritten | Closed |
| OD-02 | Quarter definition | UTC calendar quarters. Quarters from the launch date | UTC calendar quarters | P4 |
| OD-03 | Does a seat in its unstake cooldown still earn | Yes until unstaked. No from the request | Yes. The cooldown protects jury integrity, not revenue | P4 |
| OD-04 | Claim window and unclaimed amounts | Stay claimable, no expiry. Expire to a later pool. Expire to the treasury | No expiry. Claimable from 7 days after the quarter ends | P4 |
| OD-05 | What a silent juror forfeits | Seat time of the serving span, in quarters not yet final. Revenue as today | Seat time, with a 7 day close grace | P4 |
| OD-06 | Who may send revenue to the Council | The market only, with sweep ids. Anyone | The market only | P3 and P4 |
| OD-07 | Rounding dust in a quarter | Stays in the Council as unallocated. Rolls into the next pool. Goes to the treasury | Stays. At most 0.001 USDC a quarter | P4 |
| OD-08 | The residual of a resolved market | All to the treasury. Split 75% and 25% | All to the treasury | P3 |
| OD-09 | Treasury account and no-decision recipient | The same verified Trezu account for both. Different accounts | The same account. No address is assumed | Before the first mainnet sweep |
| OD-10 | Identity for market writes | Require a NEAR wallet for v1. Add signed-message authorisation later | NEAR wallet for v1. State it before funding | P8 |
| OD-11 | Rename `business_wallet` to `treasury` | Rename now. Keep | Rename now, nothing is deployed | P3 |
| OD-12 | DAO thresholds | 3 of 5 default, 4 of 5 for function calls, unanimity for membership, policy and upgrades. Other counts | As in [owner-and-keeper.md section 7](owner-and-keeper.md#7-recommended-dao-policy), 72 hour period | Before the handover |
| OD-13 | Build the owner `settle` fallback `reconcile_leg` for the treasury leg | Build. Skip | Build, about 20 lines | P3 |
| OD-14 | Per-market size cap and total value cap in code | Operating control only (today). On-chain `max_locked` per market | Operating control for the hackathon. On-chain cap before mainnet | Before mainnet |
| OD-15 | Bond size, jury size, windows | Test values. Spec starting values (jury 11, window 2 hours, 48 hour panel) | Spec starting values on mainnet, short windows on testnet | Before testnet |
| OD-16 | Keeper hosting, keys and who is paged | One host and one person. Two hosts | One host and a second person for pages | P6 |
| OD-17 | How to test a quarter | Unit tests with controlled time and a patched sandbox state. A shorter quarter in a test-only build | Unit tests and patched state. No test-only constant in the shipped wasm (the audit rejected it) | P4 |
| OD-18 | The 1Click route | Recipient type, refund type and minimums are not yet measured | Measure one real route before the funding screen ships | P9 |

---

## 10. Decisions for the owner

In order of how much they block.

1. Approve the policy numbers (OD-12). They set the DAO before handover. OD-01 is DECIDED: the DAO voting period is the only delay.
2. Accept or change the quarterly rules (OD-02 to OD-07). They fix what holders are promised: calendar quarters, seat time weighting, claimable 7 days after a quarter ends, no expiry.
3. Create the Trezu treasury and give the account id (OD-09). No sweep to the treasury is safe before it is verified.
4. Accept NEAR wallets as the only way to use market write calls in the first release (OD-10), or ask for signed-message authorisation.
5. Choose how the residual and the no-decision share reach the treasury (OD-08, OD-11).
6. Decide the launch caps and whether they live in code (OD-14).

---

## 11. Unverified or assumed

- Whether 1Click can deliver USDC into a user's Intents account with a recipient type of Intents, what it costs, and how a failed or partial conversion is refunded. The previous spec listed this as still to be measured, and `spec.md:142-143` says to verify the route again before real funds.
- The real USDC contract and token id were never run. The sandbox uses `mock-ft`. Circle's blocklist and pause behaviour on NEAR are not known.
- The verifier views `is_account_locked` and the pause check were read in source and not run (INTENTS-PROOF.md, section 5).
- Who holds the verifier's pause, lock and force roles on mainnet. They can stop or move the contracts' funds.
- Whether a callback in a market contract reads `mt_transfer_call`'s result correctly under every failure was shown only by sandbox tests that exist and were not run here.
- SputnikDAO behaviour was read in source at the pinned revision and not run. The format the DAO accepts for `gas` was checked only in the current `near-gas` source. Trezu's interface may not create these function calls or may set its own roles.
- The view gas limit for `total_owed` at scale, and the gas of the Council receipt after the quarterly change, were not measured.
- Every effort estimate in section 8 is a guess.
- The sandbox test suites, `cargo` unit tests and the web tests were not run. Existing test names in the specs are evidence that the test exists.
- The contract source moved while it was read, so a line number may be a few lines off after a later edit.

---

## 12. Evidence and limits

| Item | What it shows | What it does not show |
| --- | --- | --- |
| Reading all contract source, tests list, harness, keeper, CI, web adapter layer and the docs | The facts and file lines in the specs | Runtime behaviour. Anything I2 changed after 09:38 |
| 23 keeper tests passed | The pure decision functions and the deny-list helper behave as their tests say | Any chain behaviour |
| The treasury probe | The deny-list gaps in F-03 | That the DAO would accept the proposals |
| Sputnik source at the pinned revision | Execution at approval, expiry rule, threshold rule, kind labels | The deployed DAO's policy and code hash |

Nothing here changes code, runs a transaction or authorises a deployment.
