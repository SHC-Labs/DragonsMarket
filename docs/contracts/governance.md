# Dragons Market: Trezu administration handoff

Trezu/SputnikDAO replaces the retired custom governance contract.

| Field | Value |
| --- | --- |
| Updated | 8 November 2026 |
| Decision | Accepted |
| Proposed DAO | `dragonsmarket.sputnik-dao.near`; production policy and treasury configuration awaiting review |
| Contract integration | Contract team |
| Product authority | [Specification](../spec.md#7-architecture-and-administration) |

## Contents

1. [Required behaviour](#1-required-behaviour)
2. [The helper and the keeper](#2-the-helper-and-the-keeper)
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
are not the target administration ABI.

---

## 2. The helper and the keeper

Status: built and exercised against checksum-pinned Sputnik WASM on a local NEAR sandbox.
The production DAO handover and funded acceptance remain separate gates.

[treasury.mjs](../../contracts/keeper/treasury.mjs) prepares wallet requests using Sputnik's
`add_proposal` and `act_proposal`. It does not sign or submit a transaction. It replaces the earlier
deny-list of five method names with an allow-list of every owner method of Market, Oracle,
Council and Rounds in the current source, including `upgrade`, `seal`, `propose_owner`, `accept_owner` and
`set_fee_recipients`. Each entry fixes the arguments and their limits, the deposit and the gas. Any
other method is refused, and a test scans all four contracts so that a new owner method cannot be
missing. The treasury account and Market/Oracle/Council IDs are required inputs; Rounds is optional,
but its proposals require an explicit distinct Rounds ID. The proposal bond is read from `get_policy`.
Oracle and Rounds support atomic `set_publishers(publishers, threshold)` rotation with a nonempty,
bounded, distinct Ed25519 set and strict majority. Oracle's configured maximum is rechecked before
proposal preparation and voting. Removed signers cannot authorize new price submissions.

The vote helper builds `act_proposal` from the proposal the DAO stores, checks a `FunctionCall`
against the same allow-list (a configured receiver, one action, the entry's deposit and gas, valid
arguments, code staged for an `upgrade`), and refuses to approve any of the other Sputnik proposal
kinds that change membership, policy, DAO code, treasury funds, bounties or staking unless the caller
names the kind. `stage_code` carries the wasm as raw input and is not a proposal: `prepareStageCode`
builds that request and `codeHash` gives the value `upgrade` takes. The rules and the tests are in
[the owner model](specs/owner-and-keeper.md#5-the-allow-list-that-replaces-the-deny-list).
`backend/test/dao-chain.test.ts` exercises the actual proposal and vote builder through a
two-of-three Sputnik DAO, including publisher rotation, upgrades, key removal and the
production keeper's approval/signing path. This is local execution evidence, not evidence
that the proposed mainnet DAO has the same policy or approved code.

The keeper's `--treasury` option observes account funding. With `--watch-dao` it also lists the DAO's
open proposals that name the configured contracts and flags any the allow-list refuses. It never votes,
and it does not configure the DAO or move ownership. The retired `--governance` option is rejected.

---

## 3. Work to complete

- [ ] Approve the proposed DAO's code, policy and member roles. Its policy at finalized block
  223711328 allowed one-of-five approval for calls and transfers; resolve this before handover.
- [x] Specify supported administrative actions, arguments, deposits and gas (the allow-list, with tests). Receipt handling is not specified: the helper does not submit anything.
- [x] Replace the helper's deny-list with the allow-list.
- [x] Exercise DAO voting, outsider refusal, upgrades and sealed contract accounts in a local
  sandbox using actual Sputnik WASM. Repeat custody and execution acceptance on production.
- [ ] Prove owner handover for Market, Oracle, Council and any active Rounds contract, including recovery from failed steps.
- [ ] Configure the verified 75% recipient through that reviewed path.
- [ ] Check authority over treasury Intents balances and separation from user/reward backing.
- [x] Add dedicated DAO integration alongside the local owner fixtures.

Keeper signing pins the approved DAO code and canonical policy hash, requires no DAO account
keys and rejects approving roles below the reviewed minimum. It also checks financial-contract
owners, pending ownership, operator and recipients on both providers. A policy change stops
the keeper; it does not stop DAO transactions. The actual on-chain policy is the authority.

Do not infer a deployment account from an example name or silently fall back to a personal wallet.
The detailed product requirements are [R-01 through R-08](../spec.md#requirements-to-implementation-map).
