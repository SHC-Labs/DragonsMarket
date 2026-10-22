# Dragons Market: oracle contract implementation spec

**The complete function set the oracle needs for the accepted product: the dispute rules that already exist, and the Intents bond and payout custody that does not exist yet.**

| Field | Value |
| --- | --- |
| Date | 2026-10-21 |
| Status | Draft. Existing rows are checked in source. Rows marked NEW or CHANGED are PROPOSED |
| Scope | `contracts/oracle/src/lib.rs` |
| Source | Working tree on top of commit `6cad02e`, read 2026-10-21 09:00 to 09:22 |
| Revision checked | `oracle/src/lib.rs` sha256 prefix `ec8878d63390ecf8` (3586 lines, unchanged between copies, 15 lines differ from `HEAD`) |
| Index | [README.md](README.md) |

---

## Contents

1. [Summary](#1-summary)
2. [Purpose and roles](#2-purpose-and-roles)
3. [Money flows in Intents terms](#3-money-flows-in-intents-terms)
4. [State](#4-state)
5. [Message grammar](#5-message-grammar)
6. [Case lifecycle](#6-case-lifecycle)
7. [Methods that exist today](#7-methods-that-exist-today)
8. [Methods and changes required](#8-methods-and-changes-required)
9. [Views the website and keeper need](#9-views-the-website-and-keeper-need)
10. [Events](#10-events)
11. [Invariants](#11-invariants)
12. [Errors](#12-errors)
13. [Test evidence required](#13-test-evidence-required)

---

## 1. Summary

The oracle's dispute logic is complete and well tested: propose, challenge naming an answer, jury draw from the Council, commit and reveal, one escalation to a larger disjoint jury, no-decision settlement, price answers signed by publishers, deadline answers, retryable apply and unlock. Its custody is not on Intents. It still takes bonds as a NEP-141 `ft_on_transfer` from a token contract and pays them with `ft_transfer` (Checked in source: `oracle/src/lib.rs:17`, `:194-197`, `:228`, `:645`, `:915-931`). The source guard pins that interface (`tests/tests/guards.rs:48`).

This is the largest missing piece of requirement R-06. The work is a migration with the same shape the market and the Council already went through:

| Change | Section |
| --- | --- |
| Replace `bond_token` with the verifier and the exact collateral token id; replace `ft_on_transfer` with `mt_on_transfer` | 8.1 |
| Replace `withdraw_bond` payout by `ft_transfer` with `mt_transfer` from the oracle's own Intents account; add a permissionless `payout_bond` | 8.2 |
| Count bonds held and bonds owed so the keeper can reconcile the oracle's Intents balance | 8.3 |
| Case list view, events for bond movement, `jury_size` event | 8.4, 8.5 |

Dispute bonds and juror pay stay in the oracle's own Intents account. They never mix with holder revenue, which lives in the Council's account. DECIDED (README section 3).

---

## 2. Purpose and roles

The oracle decides outcomes. Someone proposes an answer with a bond. A challenge names a different answer with an equal bond and sends the case to a jury drawn from staked Council seats. The market trusts only this contract's `set_outcome`.

| Role | Set by | Powers |
| --- | --- | --- |
| Owner | `new`, `propose_owner` and `accept_owner` | `upgrade`, `seal`, `set_bond`, `set_window_ms`, `set_panel_deadline_ms`, `set_min_proposal_ms`, `set_draw_window_ms`, `set_draw_delay_blocks`, `set_jury_size`, `set_operator`, `set_no_decision_recipient`, `add_publisher`, `set_price_threshold`, `propose_owner`. DECIDED: the owner is the DAO |
| Operator | `set_operator`, owner only | `remove_publisher` only, so a leaked publisher key can be cut off in one call |
| Market | `new`, no setter | `register_market` only |
| Jurors | Drawn per case | `commit_vote`, `reveal_vote` for the case they sit on |
| Bond token | `new`, no setter (today) | `ft_on_transfer` only. After migration the verifier calls `mt_on_transfer` |
| Anyone | none | Propose or challenge by sending the exact bond, `resolve_draw`, `finalize`, `resolve_by_deadline`, `retry_apply`, `retry_unlock`, `withdraw_bond` for their own balance, `stage_code`, views |

Checked in source: roles at `oracle/src/lib.rs:226`, owner checks at `:472-589`, market check at `:604`.

---

## 3. Money flows in Intents terms

The oracle needs its own Intents account `O`. It must have no key registered in the verifier and predecessor authentication on, like the market. NEW rule for the keeper: `public_keys_of(O)` empty, `is_auth_by_predecessor_id_enabled(O)` true, `is_account_locked(O)` false.

| Money | Today (NEP-141) | Target (Intents) |
| --- | --- | --- |
| Proposer bond arrives | `ft_transfer_call` of the token to the oracle with `msg` | User calls verifier `mt_transfer_call(receiver_id=O, token_id, amount=bond, msg)`. The verifier calls `O.mt_on_transfer` |
| Challenger bond arrives | Same, `msg = challenge:<id>:<answer>` | Same through the verifier |
| A case settles | `claimable[account] += amount` in the oracle's own ledger. No token moves | Same. No verifier call. The money stays in `O` |
| Winner, jurors or recipient collects | `withdraw_bond` calls `ft_transfer` on the token | `withdraw_bond` calls verifier `mt_transfer(receiver_id=caller, token_id, amount, null, null)` with 1 yocto from `O` |
| A third party pushes a payout | Not possible | `payout_bond(account_id)` pays `claimable[account_id]` to that same account's own Intents account |
| Failed payout | `on_bond_withdrawn` restores `claimable` on error | Same. An error means the verifier receipt failed and nothing moved |

Settlement math is unchanged and already built (`oracle/src/lib.rs:1179-1250`). The ruling decides who is paid:

| Ruling | Who is paid |
| --- | --- |
| Unchallenged | The proposer gets their own bond back |
| Decided by a majority | The loser's bond is split. A quarter, rounded down, is split equally among the jurors who revealed the winning answer. The rest goes to the winner, who also keeps the rounding remainder and their own bond. The loser gets nothing back |
| No jury ever seated, in either round (added 2026-10-22) | The proposer and the challenger each get their own bond back. Nobody else is paid. The `final` ruling is `no_jury` and the event market is Void as before |
| No decision after two juries | The proposer gets their own bond back plus the part of the challenger's bond that jurors do not take. Half of the challenger's bond, rounded down, is split equally among every juror who revealed. If nobody revealed, that half goes to `no_decision_recipient` |

`JUROR_SHARE_BPS = 2500` and `NO_DECISION_JUROR_SHARE_BPS = 5000` (`oracle/src/lib.rs:63`, `:67`). PROPOSED: the no-decision recipient is the Trezu treasury. The sandbox harness already sets it to the business account (`tests/tests/common/mod.rs:171`). Juror pay is separate from the holder revenue share. A juror who never votes forfeits the revenue their seat earned while serving. That money never passes through the oracle. The Council handles it in its own accounting ([council.md](council.md#6-the-quarterly-accounting-proposal)).

---

## 4. State

### 4.1 Fields today

All EXISTING (`oracle/src/lib.rs:212-253`).

| Field | Type | Meaning |
| --- | --- | --- |
| `state_version`, `upgrade_proven`, `upgrade_in_flight` | `u16`, `bool`, `bool` | Upgrade path marks |
| `owner`, `pending_owner` | `AccountId`, `Option<AccountId>` | The DAO and a pending handover |
| `operator` | `AccountId` | Can remove a publisher |
| `market` | `AccountId` | Only caller of `register_market` |
| `bond_token` | `AccountId` | The NEP-141 contract. CHANGED, see below |
| `bond` | `u128` | Bond in force for new cases |
| `window_ns`, `panel_deadline_ns`, `draw_window_ns`, `min_proposal_ns` | `u64` | Windows, applied to markets registered from now on |
| `council` | `AccountId` | Draws juries and releases seats |
| `jury_size` | `u32` | Odd, at most 21 |
| `draw_delay_blocks` | `u64` | Blocks between a challenge and the earliest draw |
| `network` | `String` | Signed into every price |
| `publishers`, `price_threshold` | `Vec<PublicKey>`, `u32` | Price signers, at most 10, and how many must agree |
| `no_decision_recipient` | `AccountId` | Receives the jurors' half when nobody revealed |
| `markets` | `LookupMap<u64, MarketInfo>` | Per registered market: `close_at`, `resolve_by`, `rule_hash`, `price_rule` and the three windows in force at registration |
| `cases` | `LookupMap<u64, Case>` | One case per market |
| `claimable` | `LookupMap<AccountId, u128>` | Bonds waiting to be withdrawn |

`Case` (`:154-192`): `stage`, `proposer`, `proposed`, `bond`, `evidence`, `window_ends_at`, `challenger`, `challenger_answer`, `round`, `jury_size`, `draw_by`, `draw_after_height`, `commit_ends_at`, `panel_deadline`, `panel`, `first_panel`, `commits`, `votes`, `final_outcome`, `applied`, `challenged_at`, `delinquent`.

### 4.2 Changes (PROPOSED)

| Field | Change |
| --- | --- |
| `bond_token: AccountId` | Removed. Replaced by `verifier: AccountId` and `collateral_token_id: String`, the exact `nep141:<contract>` string, validated like the market |
| `bonds_held: u128` | NEW. Sum of the bonds of every case that is not final: one bond after a proposal, two after a challenge |
| `claimable_total: u128` | NEW. Sum of `claimable` |
| `pending_payouts_total: u128` | NEW. Amounts zeroed in `claimable` whose transfer has not reported yet |
| `state_version` | Bump to 2. Nothing is deployed, so no migration is needed |

---

## 5. Message grammar

`mt_on_transfer` splits `msg` with `splitn(4, ':')`, so the last part may itself contain colons (Checked in source: `oracle/src/lib.rs:645-678`, same rule today for `ft_on_transfer`).

```text
propose:<market_id>:<outcome>:<evidence>
price:<market_id>:<price>:<signatures>
challenge:<market_id>:<answer>
```

| Part | Type | Rule |
| --- | --- | --- |
| `market_id` | `u64` decimal | `bad market id` |
| `outcome`, `answer` | `yes`, `no` or `void` | `outcome must be yes, no or void` |
| `evidence` | text up to 512 bytes, may contain `:` | `evidence link is too long` |
| `price` | `u128` decimal scaled by the market's decimals | `bad price` |
| `signatures` | comma separated entries `<publisher key>.<128 hex characters>` where the key is `ed25519:<base58>` | A malformed entry, a repeated or unknown key, or a signature that does not verify refuses the whole submission |

The amount must equal the bond exactly (`send exactly the bond`). A challenge must equal the bond its case was proposed with. A price market refuses `propose` (`a price market is answered with a signed price`) and an event market refuses `price`. The signed message is `price:v1:<oracle account>:<network>:<market id>:<observation time>:<price>:<decimals>` (`oracle/src/lib.rs:341-346`).

After migration the verifier calls `mt_on_transfer(sender_id, previous_owner_ids, token_ids, amounts, msg)`. The checks mirror the market, in this order: caller is the verifier, exactly one token and one amount, the token id equals `collateral_token_id`, `previous_owner_ids == [sender_id]`. The bond is then taken from `amounts[0]`. The answer is `["0"]`, which keeps everything. A panic refunds the sender in full.

---

## 6. Case lifecycle

| From | Event | To |
| --- | --- | --- |
| no case | `propose`, or `price` for a price market | `proposed` |
| `proposed` | A challenge naming a different answer inside the window | `disputed` |
| `proposed` | The window ends and anyone calls `finalize` | `final`, unchallenged |
| `disputed` | A majority of the seated jury reveals | `final`, decided |
| `disputed` | Round 0 ends with no majority, and there is time for another round | `disputed`, round 1, one larger jury |
| `disputed` | Round 1 ends with no majority, or round 0 ends with no time left | `final`, no decision |
| no case | `resolve_by` passes and anyone calls `resolve_by_deadline` | The market is voided |

| Moment | Rule | Source |
| --- | --- | --- |
| Registration | The market calls `register_market`. The gap `resolve_by - close_at` must be at least `min_proposal + window + 2 * (draw window + panel deadline) + 30 s`. A price market is measured from its observation time and needs at least `price_threshold` publishers | `:596-639`, `:1045-1049` |
| Propose | After `close_at`, with enough time left for both rounds and a 30 s apply buffer. One case per market | `:1072-1117` |
| Challenge | Inside the window, by an account other than the proposer, naming a different answer. Sets `draw_by = now + draw window` and `draw_after_height = height + draw delay` | `:1119-1146` |
| Draw | Anyone calls `resolve_draw` from `draw_after_height` to `draw_by`. The Council reads the block seed itself. Needs 275 TGas | `:684-741` |
| Commit | The seated jury commits a hash in the first half of the panel deadline | `:747-771` |
| Reveal | In the second half. A majority of the panel settles at once | `:776-830` |
| Finalize | Anyone, after the window for an unchallenged case, or after the round for a disputed one. A first round that fails is followed by one larger jury of other accounts if time allows | `:835-850`, `:1151-1176` |
| Deadline | After `resolve_by`, anyone calls `resolve_by_deadline`. It settles what can be settled and voids a market with no case | `:857-875` |
| Apply | `settle` sends `set_outcome` to the market. `retry_apply` repeats it | `:1252-1261`, `:878-883` |
| Release | `settle` sends `unlock_case` to the Council for each jury. `retry_unlock` repeats it | `:1266-1277`, `:888-900` |

---

## 7. Methods that exist today

Gas floors are enforced with `upgrade::require_gas` (`oracle/src/lib.rs:26-43`).

| Method | Caller | Args | Returns | Yocto | Gas | Behaviour and refusals | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `new` (`:371`) | The account itself | `owner_id`, `market_contract`, `bond_token: AccountId`, `bond: U128`, `window_ms`, `panel_deadline_ms`, `draw_window_ms: U64`, `council: AccountId`, `jury_size: u32`, `draw_delay_blocks`, `min_proposal_ms: U64`, `operator_id: AccountId`, `network: String`, `price_threshold: u32`, `no_decision_recipient: AccountId` | contract | none | n/a | Refuses a zero bond, a network name that is empty or has a colon, a zero threshold, a zero window, an even or oversized jury | none |
| `stage_code` (`:428`) | Anyone | wasm as input | `Base58CryptoHash` | payable | 100 TGas | As in the market | `code_staged` |
| `upgrade` (`:440`), `migrate` (`:453`), `seal` (`:464`) | Owner, itself, owner | as the market | | none | 100 TGas floor for `upgrade` | As the market | `upgrade_sent`, `migrated`, `seal_sent` |
| `set_bond` (`:472`) | Owner | `bond: U128` | none | none | none | Applies to new cases. A case keeps its own bond. Refuses zero | `bond_set` |
| `set_window_ms` (`:481`), `set_panel_deadline_ms` (`:488`), `set_min_proposal_ms` (`:495`), `set_draw_window_ms` (`:502`) | Owner | `U64` milliseconds | none | none | none | Apply to markets registered from now on. Refuse zero | `window_set`, `panel_deadline_set`, `min_proposal_set`, `draw_window_set` |
| `set_draw_delay_blocks` (`:510`) | Owner | `U64` | none | none | none | Zero is allowed | `draw_delay_set` |
| `propose_owner` (`:517`), `accept_owner` (`:523`) | Owner, proposed account | `new_owner: AccountId` | none | none | none | As the market | `owner_proposed`, `owner_changed` |
| `set_jury_size` (`:532`) | Owner | `jury_size: u32` | none | none | none | Odd and at most 21. Applies to new challenges and new rounds | none today, NEW `jury_size_set` |
| `set_operator` (`:538`) | Owner | `operator_id` | none | none | none | | `operator_set` |
| `set_no_decision_recipient` (`:544`) | Owner | `recipient: AccountId` | none | none | none | | `no_decision_recipient_set` |
| `add_publisher` (`:551`) | Owner | `key: PublicKey` | none | none | none | ed25519 only, no duplicates, at most 10 | `publisher_added` |
| `remove_publisher` (`:565`) | Operator or owner | `key: PublicKey` | none | none | none | Refuses a key that is not a publisher and a removal that leaves fewer than the threshold | `publisher_removed` |
| `set_price_threshold` (`:581`) | Owner | `threshold: u32` | none | none | none | Between 1 and the publisher count | `price_threshold_set` |
| `register_market` (`:596`) | Market | `market_id: U64`, `close_at: U64`, `resolve_by: U64`, `rule_hash: String`, `price_rule: Option<PriceRule>` | none | none | 20 TGas reserved by the market | Idempotent. Refuses a market with too little time and a price market with too few publishers | `market_registered` |
| `ft_on_transfer` (`:645`) | The bond token | `sender_id: AccountId`, `amount: U128`, `msg: String` | `PromiseOrValue<U128>`, always 0 | none | token call | Section 5. CHANGED in 8.1 | `proposed`, `challenged` |
| `resolve_draw` (`:684`) | Anyone | `market_id: U64` | `Promise` | none | 275 TGas floor | Calls the Council's `draw` with 250 TGas | `jury_drawn` or `draw_failed` via `on_drawn` |
| `on_drawn` (`:710`) | The account itself | `market_id: U64`, `round: u8` | none | none | 15 TGas | Seats the jury only for the round the case is in | `jury_drawn`, `draw_failed` |
| `commit_vote` (`:747`) | A panel member | `market_id: U64`, `commitment: String` | none | exactly 1 | none | Commitment is `hex(sha256("<juror>:<yes\|no\|void>:<salt>"))`, 64 lowercase hex characters. Once, before `commit_ends_at` | `vote_committed` |
| `reveal_vote` (`:776`) | A panel member | `market_id: U64`, `outcome: Outcome`, `salt: String`, `reason: String` | none | exactly 1 | 80 TGas floor | Only the proposed or the challenger's answer. Must match the commitment. Reason required, at most 1000 bytes. Salt at most 64 bytes. Settles on a majority | `vote_revealed`, then `final` and `outcome_applied` on settlement |
| `finalize` (`:835`) | Anyone | `market_id: U64` | none | none | 80 TGas floor | Settles an unchallenged case after its window, or closes a round that is over | `final` or `escalated` |
| `resolve_by_deadline` (`:857`) | Anyone | `market_id: U64` | none | none | 80 TGas floor | After `resolve_by`. Refuses a case that still has time | `deadline_void`, `final` |
| `retry_apply` (`:878`) | Anyone | `market_id: U64` | none | none | 30 TGas suggested | Resends the answer to the market | `outcome_applied` via `on_applied` |
| `retry_unlock` (`:888`) | Anyone | `market_id: U64` | `Promise` | none | 35 TGas floor | Releases the jury seats again. The Council ignores a repeat | none |
| `on_applied` (`:903`) | The account itself | `market_id: U64` | none | none | 10 TGas | Marks the case applied | `outcome_applied` |
| `withdraw_bond` (`:915`) | Anyone with a balance | none | `Promise` | exactly 1 | 25 TGas suggested | Zeroes `claimable[caller]` and pays it with `ft_transfer`. CHANGED in 8.2 | none |
| `on_bond_withdrawn` (`:934`) | The account itself | `account: AccountId`, `amount: U128` | none | none | 10 TGas | Restores `claimable` on error | none |

Views today: `get_case(market_id) returns Option<Case>` (`:947`), `get_market_info(market_id) returns Option<MarketInfo>` (`:951`), `claimable_of(account_id) returns U128` (`:955`), `is_staged(code_hash)` (`:960`), `config()` (`:964`).

---

## 8. Methods and changes required

### 8.1 Bond custody on Intents (R-06)

PROPOSED. The accepted decision puts bonds in Intents until an authorised exit.

| Item | Specification |
| --- | --- |
| `new` CHANGED | Replace `bond_token: AccountId` with `verifier_id: AccountId` and `collateral_token_id: String`. Refuse an id that does not start with `nep141:` |
| `mt_on_transfer(sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String)` NEW, replaces `ft_on_transfer` | Caller must be the verifier. Checks from section 5. Runs the same `propose`, `price` and `challenge` code. Adds the bond to `bonds_held`. Returns `["0"]`. Emits `bond_received {account, amount, action, market_id}` |
| `ft_on_transfer` | Removed. A direct NEP-141 transfer to the oracle bounces. The oracle holds no token itself |
| Guard test | `EXPECTED_EXTERNAL_INTERFACES` in `tests/tests/guards.rs:44-52` changes: remove `("oracle", "ext_ft", &["ft_transfer"])`, add `("oracle", "ext_verifier", &["mt_transfer"])`. The test `the_verifier_is_only_ever_asked_to_transfer` (`guards.rs:253`) then covers the oracle |

### 8.2 Payouts (R-06)

| Item | Specification |
| --- | --- |
| `withdraw_bond()` CHANGED | Exactly 1 yocto. Zeroes `claimable[caller]`, moves the amount from `claimable_total` to `pending_payouts_total`, sends `mt_transfer(caller, collateral_token_id, amount, null, memo "bp:<n>")` from the oracle, then `on_bond_paid`. 25 TGas floor |
| `payout_bond(account_id: AccountId)` NEW | Anyone. Same as `withdraw_bond` for `account_id`, paid to that same account's own Intents account. No yocto needed from the caller. This lets a keeper pay jurors and the treasury without a DAO proposal. Nobody can redirect the money, because the receiver is always the account that owns the claim |
| `on_bond_paid(account, amount)` NEW, replaces `on_bond_withdrawn` | On error restores `claimable` and `claimable_total`, emits `bond_payout_failed`. On success emits `bond_paid {account, amount}`. Both paths reduce `pending_payouts_total` |

An error from `mt_transfer` means the verifier receipt failed and nothing moved. The verifier call returns nothing and is one receipt, so no unknown state exists unless the callback runs out of gas. The callback has 10 TGas.

### 8.3 Accounting views (R-08)

| Item | Specification |
| --- | --- |
| `bonds_held` | Increment by the bond in `propose` and again in `challenge`. Decrement in `settle` by the case's bonds (one when unchallenged, two otherwise) as they move into `claimable` |
| `bond_totals()` NEW | `{bonds_held: U128, claimable: U128, pending_payouts: U128, total: U128}` |
| `total_owed()` NEW | `bonds_held + claimable_total + pending_payouts_total`. The keeper compares it with `mt_balance_of(O, token)` |

### 8.4 Case list for the website and keeper

| Item | Specification |
| --- | --- |
| `list_cases(from_market_id: U64, limit: u32)` NEW | At most 50 ids from `from_market_id`. Returns only ids that have a case, each as `CaseSummary {market_id: U64, stage, proposed, challenger_answer: Option<Outcome>, round: u8, final_outcome: Option<Outcome>, applied: bool, votes: u32, window_ends_at: U64, draw_by: U64, panel_deadline: U64}` |

The website's Council page loads every market and then every case one by one (`web/app/council/view.tsx:13-18`). One page of this view replaces that fan-out. The keeper can also use it instead of `get_case` per market (`keeper/keeper.mjs:153-178`).

### 8.5 Smaller items

| Item | Specification |
| --- | --- |
| `set_jury_size` event | Emit `jury_size_set {jury_size}`. The audit noted the missing event |
| Floors for `retry_apply` and `withdraw_bond` | Add `require_gas` with 30 and 25 TGas |
| Owner-only list | Every setter stays owner only. Only `remove_publisher` is shared with the operator |

---

## 9. Views the website and keeper need

| Quantity | Source | Status |
| --- | --- | --- |
| A case and its public votes | `get_case` | EXISTING. Includes `votes[].reason` and `commits` |
| Cases for a list page | `list_cases` | NEW |
| Bond required to propose or challenge | `config.bond`, `Case.bond` | EXISTING |
| Windows of one market | `get_market_info` | EXISTING |
| Claimable bond of an account | `claimable_of` | EXISTING |
| Pending payout | `bond_totals().pending_payouts`, events `bond_paid`, `bond_payout_failed` | NEW |
| Reconciliation | `total_owed`, `bond_totals` | NEW |
| Publishers and threshold, network | `config` | EXISTING |

---

## 10. Events

Envelope: `EVENT_JSON:{"standard":"oracle","version":"1.0.0","event":"<name>","data":{...}}` (Checked in source: `oracle/src/lib.rs:255-260`).

| Event | Data | Status |
| --- | --- | --- |
| `proposed` | `market_id`, `proposer`, `outcome`, `evidence`, `window_ends_at`, `signers` (array of keys, empty for a plain proposal) | EXISTING |
| `challenged` | `market_id`, `challenger`, `answer`, `draw_by` | EXISTING |
| `jury_drawn` | `market_id`, `round` (number), `panel` (array) | EXISTING |
| `draw_failed` | `market_id`, `round` | EXISTING |
| `vote_committed` | `market_id`, `juror`, `commitment` | EXISTING |
| `vote_revealed` | `market_id`, `juror`, `outcome`, `reason` | EXISTING |
| `escalated` | `market_id`, `jury_size` (number), `draw_by` | EXISTING |
| `final` | `market_id`, `outcome`, `ruling` (`unchallenged`, `decided`, `no_decision`, `no_jury`), `juror_pay_each`, `paid_jurors`, `delinquent` | EXISTING |
| `outcome_applied` | `market_id` | EXISTING |
| `deadline_void` | `market_id` | EXISTING |
| `market_registered` | `market_id` | EXISTING |
| `bond_set`, `window_set`, `panel_deadline_set`, `min_proposal_set`, `draw_window_set`, `draw_delay_set`, `operator_set`, `no_decision_recipient_set`, `publisher_added`, `publisher_removed`, `price_threshold_set` | the changed value | EXISTING |
| `owner_proposed`, `owner_changed`, `code_staged`, `upgrade_sent`, `migrated`, `seal_sent` | as the market | EXISTING |
| `jury_size_set` | `jury_size` | NEW |
| `bond_received` | `account`, `amount`, `action` (`propose`, `price`, `challenge`), `market_id` | NEW |
| `bond_paid` | `account`, `amount` | NEW |
| `bond_payout_failed` | `account`, `amount` | NEW |

The `final` event carries who is paid but not the amounts that went into `claimable`. An indexer rebuilds them from the rules in section 3, or the event gains `credits: [{account, amount}]` (PROPOSED, small).

---

## 11. Invariants

| Invariant | Statement | Test status |
| --- | --- | --- |
| I-O1 exact payout | A settled case credits `claimable` with exactly the bonds that entered it, and only to the proposer, challenger, winning jurors or the recipient | `oracle lib.rs:1572` proptest (test exists, not run). `juror_pay.rs:42` sandbox |
| I-O2 reconciliation | With no payout in flight, `mt_balance_of(O, token) >= total_owed()` | NEW |
| I-O3 a full binary ballot settles | An odd jury with full turnout always has a majority | `oracle lib.rs:1647` proptest |
| I-O4 no free self-dispute | A pair of accounts that propose and challenge each other ends down by at least the juror share | `oracle lib.rs:1676` proptest, `attacks.rs:1205` |
| I-O5 holder revenue never touches the oracle | `O` receives only `mt_on_transfer` bonds and sends only `claimable` payouts | NEW source guard: the oracle never names `revenue` |
| I-O6 bond equals the case's bond | A challenge matches the bond its case was proposed with, so `set_bond` touches only new cases | `oracle lib.rs:3529` unit test |
| I-O7 deadline | At `resolve_by`, every registered market's case is settleable or has no case | `oracle lib.rs:2652` proptest |

---

## 12. Errors

Exact panic strings (Checked in source: `oracle/src/lib.rs`).

| Group | Strings |
| --- | --- |
| Access | `owner only`, `operator or owner only`, `market contract only`, `not the proposed owner`, `wrong token` (becomes `only the verifier can deliver money` after migration) |
| Bond delivery | `bad market id`, `send exactly the bond`, `unknown action`, `outcome must be yes, no or void`, `bad price`, `a price market is answered with a signed price`, `not a price market` |
| Case state | `no case for that market`, `an answer was already proposed`, `the market has not closed yet`, `too late to propose, the market will be voided at its deadline`, `evidence link is too long`, `nothing to challenge`, `the challenge window closed`, `you cannot challenge your own answer`, `a challenge must name a different answer than the proposal`, `market is not registered` |
| Jury | `no open dispute`, `the jury is already drawn`, `too early to draw the jury`, `too late to draw a jury`, `no challenger`, `not on the panel for this case`, `the commit phase is over`, `commitment must be 64 lowercase hex characters`, `already committed`, `no commitment to reveal`, `no challenger answer`, `vote for the proposed answer or the challenger's answer`, `the commit phase is still open`, `the panel deadline passed`, `already revealed`, `the vote does not match the commitment`, `a reason is required`, `reason is too long`, `salt is too long` |
| Settlement | `challenge window is still open`, `the panel still has time`, `already final`, `the answer deadline has not passed`, `already resolved`, `the case still has time; finalize it when its round is over`, `nothing to apply`, `no final outcome`, `no settled dispute to unlock`, `nothing to withdraw` |
| Registration | `resolve_by is too soon after close_at for a case to finish`, `not enough price publishers are configured`, `observation_time must not be before close_at` |
| Price | `the observation time has not come`, `not enough valid publisher signatures`, `a signature is 128 hex characters`, `a signature is hex`, `a signature is <publisher key>.<hex>`, `bad publisher key`, `not a publisher`, `a publisher signed twice`, `a signature does not match` |
| Settings | `bond must be positive`, `windows must be positive`, `jury size must be odd and at most 21`, `publishers use ed25519 keys`, `already a publisher`, `there can be at most 10 publishers`, `that would leave fewer publishers than must sign`, `the threshold must be between 1 and the number of publishers`, `the network name must be a word without a colon`, `at least one publisher must sign a price` |
| Gas | `attach at least 80 TGas: a call that settles a case sends the answer to the market and releases the juries`, `attach at least 275 TGas: the jury draw reads every staked seat`, `attach at least 35 TGas: each jury's release gets an equal share of what is attached`, `attach at least 100 TGas to upgrade` |

---

## 13. Test evidence required

Existing tests were not run in this task.

| Requirement | Evidence that exists | Evidence still required |
| --- | --- | --- |
| R-04 jury, seat locks, case obligations | `council.rs:25-266`, `rounds.rs`, `staking.rs:187`, `safety.rs:253`, unit `oracle lib.rs:1909-1965` | Nothing new for the dispute rules |
| R-06 bonds on Intents | None. Bond tests use `ft_transfer_call` to the oracle (`common/mod.rs:331-339`) | A harness change so `propose`, `challenge` and `price` go through `mt_transfer_call`. Refusal refunds in full. A plain deposit to the oracle is surplus. A refused payout restores `claimable`. `payout_bond` pays only the account itself. `total_owed` equals the verifier balance after a full dispute with a second round. Holder revenue never appears in the oracle account |
| R-06 juror pay separate | `juror_pay.rs:42`, `:69`, `:112` | A sandbox check that the Council's Intents balance is unchanged by a settlement and a payout |
| R-08 views | `get_case` JSON in `flow.rs` | `list_cases`, `bond_totals`, `total_owed` with exact JSON shapes |
| R-07 owner is a DAO account | owner fixture only | A real SputnikDAO calling `set_bond`, `add_publisher` and `upgrade` |

The build rule from the previous spec (section 20) applies: break each new rule on purpose and confirm its test fails.
