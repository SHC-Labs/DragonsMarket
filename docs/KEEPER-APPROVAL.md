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
| `marketIds` | Explicit decimal-string IDs whose lifecycle the keeper may advance. Do not include market 7 until its owner-approved disposition is recorded. |
| `contracts` | One entry for every configured market/oracle/Council/rounds/verifier, plus `nft` and `collateral`. Each has `accountId`, base58 `codeHash`, 40-character `sourceCommit` and HTTPS `buildEvidence`. Evidence must link that source/build to those exact bytes. |
| `controls` | Approved `owner`, `operator`, `treasury` NEAR accounts. Pending ownership, changed links, pauses and upgrades in flight stop signing. |
| `keeper.accountId` | Dedicated gas-funded keeper account; never an owner/treasury credential. |
| `keeper.publicKeys` | Three distinct ed25519 public keys named `market`, `oracle`, `council`. The supplied secrets must derive these keys. |
| `keeper.minBalanceYocto`, `keeper.maxKeyAllowanceYocto` | Positive decimal strings. The first is required balance after storage reserve; the second caps each key's remaining gas allowance. Choose and fund these deliberately. |
| `keeper.maxActionsPerRun`, `keeper.maxGasPerRunTgas` | Integers in 1-10 and 1-3000 respectively. A batch exceeding either is refused, not partially submitted. Include global fee/day actions when choosing the budget. |

Contract code hashes, links, owner/operator/treasury and gas reserve are read from both providers at the same recent finalized block before each call. All configured contracts and the NFT/verifier/token dependencies must match. The providers must have different hostnames; operators must separately confirm provider independence. An allowed upgrade invalidates the approval until reviewed. Matching hashes proves the configured build identity, not that the build itself is safe.

The same check requires no NEAR access keys on the financial contracts or NFT, a proven upgrade path on each financial contract, no Intents signing keys, predecessor authentication enabled, unlocked custody and unpaused verifier transfers. Ethereum-style implicit financial accounts are refused because Intents cannot enumerate their implicit signing authority. Missing or malformed evidence stops signing. These checks read current state; they do not delete keys or prove the actual DAO policy, voting and upgrade recovery. See [the authority handoff](CONTRACT-AUTHORITY.md).

After supplying the reviewed packet, registered manifest and restricted keeper database connection, run `pnpm --filter dragons-market-backend keeper:verify-approval` in the built image **without signing keys**. This checks the packet, database manifest, recent successful reconciliation/integrity and live code/control agreement. It submits nothing and does not approve its own input. Run `KEEPER_MODE=check` separately against the initialized volume to inspect the due actions and current feed.

Only the keeper receives `KEEPER_MARKET_KEY`, `KEEPER_ORACLE_KEY` and `KEEPER_COUNCIL_KEY`. Their on-chain receiver/method scope must match the keeper method lists and have finite gas allowances. Never supply `KEEPER_KEY`, owner keys or treasury keys. Keep keys out of commands, chat, Git, build arguments and logs. Provision keys through the account custodian's signing workflow, then inject them securely into the keeper service. Run the controlled acceptance pass before enabling its cron.

This only covers permissionless market/Oracle/Council advancement. It does not publish prices, select subjective outcomes, upgrade contracts, mint NFTs, fund accounts or authorize agent grants. Those operations retain their separate approval and acceptance requirements.
