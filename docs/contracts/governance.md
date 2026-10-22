# Dragons Market: Trezu administration handoff

Trezu/SputnikDAO replaces the retired custom governance contract.

| Field | Value |
| --- | --- |
| Updated | 21 October 2026 |
| Decision | Accepted |
| Treasury account | Not created or configured |
| Contract integration | Claude |
| Product authority | [Specification](../spec.md#7-architecture-and-administration) |

## Contents

1. [Required behaviour](#1-required-behaviour)
2. [Existing helper](#2-existing-helper)
3. [Work to complete](#3-work-to-complete)

---

## 1. Required behaviour

The treasury handles member roles, approval thresholds and approved project spending. It receives
75% of earned platform fees. Council-controlled rewards receive 25%, with quarterly claims and
backing in Intents. Treasury votes do not replace Council jury decisions.

DECIDED (owner, 21 October 2026): sensitive administrative changes use Trezu/Sputnik member
approvals, and the voting period is the only delay. No post-approval delay will be built.
SputnikDAO executes a proposal in the same call as the approval that reaches the threshold, so
the voting period gives public visibility and a deadline, not an exit window after approval. The
reasoning, the protections that do not depend on a delay and the PROPOSED DAO policy are in
[the owner model](specs/owner-and-keeper.md#2-the-owner-model). Verify ownership, upgrades,
failed-call recovery and access-key control against a real SputnikDAO.

The custom contract is absent from the active workspace, build and test fixtures. Its methods
are not the target administration ABI. Past findings remain in [AUDIT.md](AUDIT.md).

---

## 2. Existing helper

[treasury.mjs](../../contracts/keeper/treasury.mjs) prepares wallet requests using Sputnik's
`add_proposal` and `act_proposal`. It requires an explicit treasury account and proposal bond,
preserves the proposal kind for voting, and does not sign or submit a transaction.

Today the helper uses a deny-list: it refuses to prepare or approve `upgrade`, `seal`,
`propose_owner`, `accept_owner` and `set_fee_recipients`, and lets every other method through.
That refusal was written for a delay route that will not be built. PROPOSED: replace it with the
allow-list in [the owner model](specs/owner-and-keeper.md#5-the-allow-list-that-replaces-the-deny-list),
which can prepare those owner methods and keeps the guard on proposal kinds that change the DAO
policy or membership. Local owner fixtures test application permissions and upgrades; they do not prove real DAO
membership, voting or execution behaviour.

The keeper's `--treasury` option observes account funding. It does not configure the DAO or move
ownership. The retired `--governance` option is rejected.

---

## 3. Work to complete

- [ ] Create the Trezu treasury and verify its actual account, code, policy and member roles.
- [ ] Specify supported administrative actions, arguments, deposits, gas and receipt handling.
- [ ] Replace the helper's deny-list with the allow-list and test that keys and direct calls cannot bypass DAO ownership.
- [ ] Prove owner handover for market, oracle and Council, including recovery from failed steps.
- [ ] Configure the verified 75% recipient through that reviewed path.
- [ ] Check authority over treasury Intents balances and separation from user/reward backing.
- [ ] Replace the local owner fixture with dedicated DAO integration evidence where appropriate.

Do not infer a deployment account from an example name or silently fall back to a personal wallet.
The detailed product requirements are [R-01 through R-08](../spec.md#requirements-to-implementation-map).
