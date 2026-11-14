# Keeper signing approval

No current contract build is approved by this document. The five rehearsal addresses are selected, but source/build equivalence and market 7's disposition remain unresolved. Do not copy observed hashes into an approval to bypass those findings.

The runner consumes `KEEPER_APPROVAL_JSON` and its exact UTF-8 SHA-256 in `KEEPER_APPROVAL_SHA256`. Store both as protected deployment configuration after review. This digest detects mismatched artifacts; it is not a reviewer signature. Anyone who can replace both values or the running image controls this gate, so Railway/GitHub access and reviewed public releases remain part of the trust boundary.

The JSON shape is enforced by `backend/src/keeper-approval.ts`:

| Field | Required content |
| --- | --- |
| `version`, `network` | `1`, `mainnet` |
| `deployment` | The exact registered backend deployment object: ID, start block, contract map, collateral ID and decimals. No later start block or missing rounds entry. |
| `approvedBy`, `approvedAt`, `expiresAt` | Reviewer identity and ISO timestamps. Maximum approval lifetime is 30 days; expiry stops further signing. |
| `reviewEvidence` | HTTPS review record covering deployed build equivalence, custody, economic parameters, market rules/deadlines and operating authorization. The process does not fetch this URL. |
| `marketIds` | Explicit decimal-string IDs whose lifecycle the keeper may advance. Excluded markets stay queued without taking batch slots. Do not include market 7 until its owner-approved disposition is recorded. |
| `contracts` | One entry for every configured market/oracle/Council/rounds/verifier, plus `nft` and `collateral`. Each has `accountId`, base58 `codeHash`, 40-character `sourceCommit` and HTTPS `buildEvidence`. Evidence must link that source/build to those exact bytes. |
| `controls` | Approved `owner`, `operator`, `treasury` NEAR accounts. Pending ownership, changed links, pauses and upgrades in flight stop signing. |
| `governance` | Approved owner DAO `codeHash`, `sourceCommit`, HTTPS `buildEvidence`, canonical `policySha256` and integer `minApprovals` (2-100). Code may be inline WASM or an immutable global contract hash; mutable global account references are refused. |
| `keeper.accountId` | Dedicated gas-funded keeper account; never an owner/treasury credential. |
| `keeper.publicKeys` | Distinct ed25519 public keys named `market`, `oracle`, `council`, plus `rounds` exactly when Rounds is configured. The supplied secrets must derive these keys. |
| `keeper.minBalanceYocto`, `keeper.maxKeyAllowanceYocto` | Positive decimal strings. The first is required balance after storage reserve; the second caps each key's remaining gas allowance. Choose and fund these deliberately. |
| `keeper.maxActionsPerRun`, `keeper.maxGasPerRunTgas` | Integers in 1-10 and 1-3000 respectively. A batch exceeding either is refused, not partially submitted. Include global fee/day actions when choosing the budget. |

Contract code hashes, links, owner/operator/treasury and gas reserve are read from both providers at the same recent finalized block before each call. All configured contracts and the NFT/verifier/token dependencies must match. The providers must have different hostnames; operators must separately confirm provider independence. An allowed upgrade invalidates the approval until reviewed. Matching hashes proves the configured build identity, not that the build itself is safe.

The same check requires no NEAR access keys on the financial contracts or owner DAO, a proven upgrade path on each financial contract, no financial-contract Intents signing keys, predecessor authentication enabled, unlocked custody and unpaused verifier transfers. The Oracle's no-decision recipient must equal the approved treasury. Ethereum-style implicit financial accounts are refused because Intents cannot enumerate their implicit signing authority. Missing or malformed evidence stops signing. These checks read current state; they do not delete keys or prove voting and upgrade recovery. See [the authority handoff](CONTRACT-AUTHORITY.md).

The NFT collection is a third-party contract whose owner keeps its key, so its keys are not checked. Its approved code hash is: a code change on the collection stops signing until a new packet approves it. Whoever holds that key can still mint, so the Council's seat policy depends on the collection owner.

The owner DAO's code and policy are checked on both providers before every submission. Compute `policySha256` with the exported `daoPolicyHash` in `backend/src/dao-policy.ts` over the reviewed `get_policy` response: sort each role's group members and permissions (Sputnik sets), then recursively sort JSON object keys and take UTF-8 SHA-256. Other array order is preserved. Do not use a digest to approve an unreviewed policy. Every role able to approve proposals must use distinct named group members, role-weight voting and at least `minApprovals` effective votes. Wildcards and per-kind overrides are checked independently; a stronger default cannot mask a one-vote Approver role. Token-weight and Everyone approver roles are unsupported. Calls and transfers must remain executable. Pinning stops this keeper after policy drift; it cannot prevent the DAO itself executing an already-authorized proposal. Governance changes require review, a new packet and a fresh read-only check.

After supplying the reviewed packet, registered manifest and restricted keeper database connection, run `pnpm --filter dragons-market-backend keeper:verify-approval` in the built image **without signing keys**. This checks the packet, database manifest, recent successful reconciliation/integrity and live code/control agreement. It submits nothing and does not approve its own input. Run `KEEPER_MODE=check` separately against the initialized volume to inspect the due actions and current feed.

The policy guard also checks non-voting groups and all their voting-policy overrides. Proposal status evaluation is reachable through rejection and finalization, so checking only `VoteApprove` permissions is insufficient. The sandbox regression demonstrates execution through a zero-threshold role's rejection vote. Every named group must meet the approved minimum; unsupported member/token-weight roles are refused. An `Everyone` role may submit or finalize proposals, but cannot be an approver in an accepted policy.

Only the keeper receives `KEEPER_MARKET_KEY`, `KEEPER_ORACLE_KEY`, `KEEPER_COUNCIL_KEY` and, when configured, `KEEPER_ROUNDS_KEY`. Their on-chain receiver/method scope must exactly match the keeper method lists and have finite gas allowances. The Oracle list now includes `payout_bond`; Rounds permits only `sweep_fees`. Old signing packets and method scopes must be replaced after the reviewed Oracle upgrade. Never supply `KEEPER_KEY`, owner keys or treasury keys. Keep keys out of commands, chat, Git, build arguments and logs. Provision keys through the account custodian's signing workflow, then inject them securely into the keeper service. Run the controlled acceptance pass before enabling its cron.

This covers permissionless market/Oracle/Council advancement, Oracle bond payouts and optional Rounds fee sweeping. It does not publish prices, select subjective outcomes, upgrade contracts, mint NFTs, fund accounts or authorize agent grants. Those operations retain their separate approval and acceptance requirements.
