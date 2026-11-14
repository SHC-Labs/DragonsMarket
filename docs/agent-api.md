# Trading from an Agent API agent

For developers whose agent runs on the NEAR Intents Agent API and should stake in Dragons Market rounds or trade its
markets. Account names here are placeholders; use only the reviewed deployment's manifest, never a rehearsal account
copied from a message:

- `<rounds>` and `<market>`, the two contracts;
- `<token>`, the collateral token: `collateral_token_id` in either contract's `config`, without its `nep141:` prefix;
- `<agent>`, the agent's `near_account_id` from `GET /v1/agents/{agent_id}/wallet`.

## The site's MCP connection

The website uses an explicit owner-signed flow: wallet login, agent creation and account policy, a grant to Dragons
Market, owner funding, then a separate signed MCP connection. Wallet login alone authorizes no spending. The AI gets
only its `dmk_` connection token. The worker keeps the partner key and sealed `ngt_` grant; neither reaches MCP clients.

MCP approval uses a versioned message binding the request ID, site, network, owner, agent, collateral,
allowed actions, per-buy/stake limit, rolling allowance, signing deadline and exact access expiry. The browser
reconstructs it from the user's form values and connected account before opening the wallet, then checks the
returned account and deadline again. The server reconstructs the same message from its stored permissions,
verifies the NEP-413 signature and live FullAccess key, and issues the token with one conditional update.
Changed permissions, revocation, expiry and concurrent consumption during key verification cannot issue a token.
The signed expiry is fixed at request creation; a delayed signature does not extend access.

Agent provisioning and trading currently accept NEAR owners. The separate [EVM website login](WALLET-IDENTITY.md)
can inspect owned agents and revoke existing connections/grants through the backend. It does not create an agent
or grant spending permission. EVM provisioning, policy changes, new grants, MCP approval and execution remain
refused until their policy, consent and funding/cash-out paths are integrated.
The local EVM grant/revoke signing adapter is described in [WALLET-IDENTITY.md](WALLET-IDENTITY.md#implemented-evm-grantrevoke-signing-boundary).
The separate [create/freeze adapter](WALLET-IDENTITY.md#implemented-evm-createfreeze-signing-boundary)
validates signed wallet calls against the expected policy and custody account. Both are locally tested
components; EVM wallet UI integration and activation remain unfinished. The implemented
[inspection/revocation path](WALLET-IDENTITY.md#implemented-session-to-worker-inspection-and-revocation)
keeps session identity separate from the signer and payout destination.

Before deployment, the worker checks `/v1/network` against the configured mainnet wallet contract and NEAR owner
support, and authenticates the partner key with `/v1/whoami`. Runtime `/health/ready` repeats those reads with a
2.5-second provider deadline and a 30-second cache; concurrent probes share one request pair. Database readiness is
checked every time. These reads establish compatibility and a valid credential, not approval of the returned tenant,
a funded wallet, a synchronized account policy or support for EVM owners in Dragons. Confirm the tenant in the key
portal and complete the funded acceptance tests separately. Upstream dependency status is advisory.

Provider failure returns a generic not-ready response without terminating the worker or suspending reconciliation.
Readiness does not authorize an operation. The dispatch checks below still apply to every new send. The sweep logs
fixed failure messages without including provider responses, credentials or signed consent.

The skill is served at `/skill.md`, through the `dragons-market://skill` resource and the `trade-dragons-market` prompt.
`get_policy` reads the account policy from the Agent API, reports whether it is applied and provider-synced, and
compares it with the application's expected policy. A changed or unrecognized policy is marked for owner review,
never represented as the expected policy. The worker repeats this check before every send, including recovery;
an unapplied, unsynchronized, frozen or mismatched policy blocks it. It also reports the signed connection limits and their enforcement scope.
Policy amounts are atomic units. `get_agent` reports connection amounts as decimals and includes remaining allowance.

Freeze/unfreeze reconciliation reads the current applied, synchronized policy; the success or failure of an older
intent does not establish the account's current state. A per-account observation counter rejects responses that
overlap a newer local update. Unconfirmed policy keeps the local `frozen` execution hold, so that flag can be more
restrictive than the last confirmed custody state. If an unfreeze reports success before its policy is confirmed,
continue observing the same correlation; the background sweep retries too. Do not create a replacement signature
or report that execution resumed until the applied readback succeeds. See the migration and rollback sequence in
[OPERATIONS.md](OPERATIONS.md#agent-authorization-and-uncertain-payments).

The MCP only exposes the supported Dragons Market actions. Account administration, policy changes, funding, NFT
minting and arbitrary native calls are not MCP tools. Its `list_markets` scans 50 ids at a time: pass
`next_from_market` as `from_market`, including after empty pages, until it is null.

There are two distinct checks before signing:

| Rule | Enforcer | Scope |
| --- | --- | --- |
| Per-buy/stake amount and rolling 24-hour allowance | Dragons Market worker and transactional Postgres reservation | One signed MCP connection, across both venues |
| Revoked/expired connection, allowed action and cash-out recipient | Dragons Market worker | One connection and its owner |
| Grant, freeze, native receiver permissions and supported custody policy | Agent API and custody provider | The agent account |
| Cash-out asset and amount caps | Agent API and custody provider | The agent account's Intents withdrawals |
| Exact call and finalized business outcome | Dragons Market worker reading chain receipts | One idempotent operation |

MCP connection limits are not copied into the API's account-wide withdrawal limits: those describe different money
flows and would not constrain USDC already held inside a market. Native `buy` and `stake` attach one yoctoNEAR;
the provider cannot infer their USDC trade size from that deposit. Native calls do not inherit USD budgets,
timelocks, schedules or owner approvals. Enforcing those trade amounts independently at custody requires a provider
capability that binds method arguments to value, or a reviewed change to the trading/funding route. It is not achieved
by adding unsupported fields to an API request. Do not advertise that protection as available.

Concurrent requests reserve their spend under a database lock before dispatch. Pending, uncertain and review-needed
actions keep their allowance reserved even after 24 hours; only proved failures release it. Confirmed trades count
for 24 hours after confirmation. Separate connections have separate limits; website actions share the configured
owner allowance across that owner's agents. Connection expiry/revocation and grant state are checked again after
the policy read. An operation already admitted may still complete after revocation; reconciliation keeps following
its recorded correlation without requiring a live grant or permitting a new send.

Owner consent is checked against the requested grant credential, owner, agent, network, expiry and nonce before it
reaches the wallet. Revocation consent must name the requested grant. Backend and browser both allow only policy
storage and the requested freeze/unfreeze transition, with bounded gas/deposit and no extra wallet callback or
sender fields. NEAR delegates and EVM policy messages bind the custody wallet, tenant, agent, policy revision,
complete declared policy commitment and approved storage refund recipient. The worker builds that approval from
the owner operation and verified API identity/account reads; it never accepts the provider's approval object.
Freeze/unfreeze restate applied rules with only the freeze flag changed. A failed proposal can be retried using the
last applied rules and the next unused revision, after checking the current snapshot against bounded history.
Pending revisions, changed snapshots and missing applied history refuse a new signature request.
The policy document is encrypted: its contents and custody enforcement still depend on the Agent API
and provider, and must be exercised with the production integration before launch.

The provider's signer must match both the authenticated account and public key. Its verified signer descriptor
is retained in the intent sent to the browser. The browser also checks canonical grant/revoke contents, nonce,
network, authority, lifetime and selected owner, and refuses a wallet response from another account/key. These
checks prevent a familiar recipient or message prefix from standing in for the actual permission being signed.

Deploy the matching worker/API and web revision together. Old unsigned MCP requests must be created again;
they fail with `access_request_changed`. Previously issued tokens keep their existing expiry and permissions.
Old pending provider intents without a signer descriptor cannot be signed in the new browser; let them expire
and prepare a new request. Unsigned NEAR policy intents without the new approval context also require regeneration;
the worker rechecks stored delegates before submission. Status observation/reconciliation of already submitted
intents remains available, including older requests.
The NEAR consent change adds no database migration, service or scheduled job. The subsequent EVM
consent adapter adds the same pinned `viem` version to the browser that the backend already uses.
For policy storage, set worker `AGENT_API_POLICY_SPONSOR` to the provider's reviewed public refund account, or leave
it blank for unsponsored storage. The activation packet must explicitly pin the same account or `null`.

Owner-intent observations apply their status and account/grant effects atomically. Concurrent stale responses cannot
overwrite a completed outcome or replay its effects after a later owner action. Retry observation under the same
correlation after a race; a conflicting final outcome requires investigation, never a replacement signature.

Recovery compares the journaled transaction with the current plan before doing anything. If they differ, the operation
stays in review with `operation_plan_changed`; its allowance remains reserved. Reconcile the original request and
receipt instead of resubmitting a replacement or clearing its reservation. These application checks do not establish
EVM-owner support or an independently enforced custody-side trade budget.

## How it fits together

The Agent API keeps an agent's money in its NEAR Intents balance and never lets the agent call the NEAR Intents
contracts, so the contracts' Intents routes (`mt_transfer_call` and signed intents) are closed to it. It uses the token
route instead:

1. The agent withdraws the token from its NEAR Intents balance to its own NEAR account, `<agent>`.
2. It sends the token to `<rounds>` or `<market>` with `ft_transfer_call`. The contract moves it whole into its own NEAR
   Intents account and credits the agent.
3. A withdrawal from the contract pays into `<agent>`'s NEAR Intents balance, the one
   `GET /v1/agents/{agent_id}/balances` shows.

Every contract call is `POST /v1/agents/{agent_id}/native/near/call` with a grant token and an `Idempotency-Key`. The
wallet provider sends it from `<agent>`, which pays the gas.

## The owner's policy

Native calls are off until the owner switches them on. These are the parts of the complete policy this needs; the values
are an example to adjust:

```json
{
  "actions": ["withdraw"],
  "assets": ["nep141:<token>", "nep141:wrap.near"],
  "limits": {
    "per_transaction": { "nep141:<token>": "100000000", "nep141:wrap.near": "100000000000000000000000" },
    "daily": { "nep141:<token>": "500000000", "nep141:wrap.near": "500000000000000000000000" }
  },
  "destinations": {
    "mode": "only",
    "list": [
      { "action": "withdraw", "chain": "near", "address": "<agent>", "memo": null },
      { "action": "withdraw", "chain": "near", "address": "<token>", "memo": null },
      { "action": "withdraw", "chain": "near", "address": "<rounds>", "memo": null },
      { "action": "withdraw", "chain": "near", "address": "<market>", "memo": null }
    ]
  },
  "native": {
    "near": { "sign_message": [], "transfer": false, "call": ["<token>", "<rounds>", "<market>"] },
    "evm": { "sign_typed_data": [], "sign_message": false, "sign_transaction": false },
    "solana": { "sign_message": false, "sign_transaction": false }
  }
}
```

What it fences and what it does not:

- `destinations` lets the NEAR Intents balance leave only for the accounts listed. The Agent API checks the NEAR a
  native call attaches against the same list, so every contract a call below pays a deposit to must be on it. That
  also allows a plain withdrawal to those contracts, and money sent that way arrives with no message, so nothing
  credits it and it is lost. The token caps in `limits` bound what one such mistake can cost; set them to what the
  agent needs.
- `native.near.call` lists contracts, not methods. Listing `<token>` lets the agent call any method of the token,
  `ft_transfer` to anyone included, for the token on `<agent>`'s NEAR account, so keep there only what is about to be
  staked. Listing `<rounds>` and `<market>` costs the owner nothing: their withdrawals pay only the caller's own NEAR
  Intents account, and leaving returns the deposit to whoever paid it.
- Native calls ignore `budget`, `timelock_ms`, `schedule` and `owner_approval`. The NEAR they attach counts as
  `nep141:wrap.near` against `assets` and `limits`, so the limit must allow the 0.05 NEAR deposit.
- Show the owner the Agent API's native-methods warning before they sign, as its owner guide asks every app to; the
  signing preview names each method the policy switches on.

## Funding the agent's NEAR account

`<agent>` needs NEAR on its own account for the 0.05 NEAR deposit and for gas. Each call below attaches at most 100
TGas, about 0.01 NEAR at the minimum gas price, and most of that is refunded. Either the owner sends NEAR to `<agent>`
from any wallet, or the agent withdraws `near` from its NEAR Intents balance to chain `near` at `<agent>`, which arrives
as native NEAR (that needs `<agent>` in `destinations`, as above).

## A stake in a round

1. Register `<agent>` with the token, once. If the token's `storage_balance_of({ "account_id": "<agent>" })` is null:

   ```json
   { "receiver_id": "<token>", "method_name": "storage_deposit",
     "args": { "account_id": "<agent>", "registration_only": true },
     "gas": "30000000000000", "deposit": "<the token's storage_balance_bounds().min>" }
   ```

2. Move the token to `<agent>` with `POST /v1/agents/{agent_id}/withdraw`:
   `{ "asset": "nep141:<token>", "amount": "5000000", "chain": "near", "recipient": "<agent>" }`. On NEAR the route
   delivers the token itself.

3. Register with the rounds contract, once. The 0.05 NEAR comes back when the agent leaves; there is no USDC fee.

   ```json
   { "receiver_id": "<rounds>", "method_name": "storage_deposit", "args": {},
     "gas": "30000000000000", "deposit": "50000000000000000000000" }
   ```

4. Pick the round. `open_rounds({ "from_index": 0, "limit": 12 })` names each series' round taking stakes now, or the
   next to open, with `opens_at` and `closes_at` in nanoseconds; a round takes no stake outside them, and at least half
   of every interval is outside them. `quote_stake({ "series_id": 0, "round": "<round>", "side": "up", "amount": "5000000" })`
   is the shares that amount buys now. Ask for a little less as the minimum, since others may stake first.

5. Stake by token:

   ```json
   { "receiver_id": "<token>", "method_name": "ft_transfer_call",
     "args": { "receiver_id": "<rounds>", "amount": "5000000", "msg": "stake:0:<round>:up:<min shares>" },
     "gas": "100000000000000", "deposit": "1" }
   ```

   At least 75 TGas must reach the rounds contract. With the sandbox's test token 84 TGas on the call was the least that
   did, so attach 100 and check it against the real token. A refusal hands the token back. A
   stake the round refuses after the money arrived, because the round started meanwhile or the price passed the
   minimum, stays in the agent's balance in the contract. To stake from that balance instead, send `deposit` as the
   message, then call `stake` with `{ "series_id": 0, "round": "<round>", "side": "up", "amount": "5000000",
   "min_shares": "<min shares>" }` and a deposit of 1 yocto.

6. After the round, `round_outcome({ "series_id": 0, "round": "<round>" })` turns from null to the outcome, and
   `claim({ "series_id": 0, "round": "<round>", "account_id": "<agent>" })` with no deposit moves the payout into the
   balance. Do not wait on `get_round`: its outcome stays null until the first claim settles the round. Anyone may call
   `claim`.

7. `withdraw({ "amount": "<get_balance>" })` with a deposit of 1 yocto and 50 TGas pays the balance into `<agent>`'s
   NEAR Intents balance.

8. To leave, `storage_unregister({})` with a deposit of 1 yocto, once the account holds no open stake, no balance and no
   withdrawal in flight. The 0.05 NEAR goes back to whoever paid it.

## A market trade

The same pattern with `<market>`: `storage_deposit` with 0.05 NEAR, then `ft_transfer_call` with the message `deposit`,
or `buy:<market id>:<yes|no>:<min shares>` to buy with the money sent (`quote_buy` says how many shares an amount buys;
the minimum must be above zero). From the balance, `buy`, `sell` and `withdraw` each take a deposit of 1 yocto, and
`redeem({ "market_id": "<id>" })` takes none. The [market manual](contracts/market.md) has every message and refusal.

An agent does not need to hold the token at all. Its owner can register it with `storage_deposit({ "account_id":
"<agent>" })`, paying the 0.05 NEAR, and fund it from their own wallet with `ft_transfer_call` and the message
`deposit_for:<agent>`, on `<market>` or on `<rounds>`. The policy can then leave `<token>` out of `native.near.call` and
out of `destinations`, which closes the `ft_transfer` risk above. This is how the agent accounts on the Dragons Market
site work: the agent calls `buy`, `sell`, `redeem`, `stake` and `claim` from its balances, and a withdrawal lands in its
NEAR Intents balance, from where the policy lets it pay only its owner.

A policy cannot see the size of a trade. The Agent API and its wallet provider judge a contract call by its receiver and
the NEAR it attaches, and a `buy` attaches 1 yocto whatever it spends from the balance. What a policy does bound is which
contracts the agent can call, where money can leave to, how much can leave, how many actions it takes an hour, and
whether it is frozen. The most a compromised agent can lose in trades is what its owner funded into `<market>` and
`<rounds>`, so fund only what it should trade. On the site, Dragons Market's agent worker also limits each trade and each
24 hours, and refuses a trade that accepts more than 10% worse than the on-chain quote.

## Reading the outcome

A native call returns a `StatusResponse`; read it with `GET /v1/status` until it settles. That status says whether the
transaction went through, not whether the contract took the stake: a refused stake is still a token call that completed
and handed the token back, and the API may report it as settled or as needing review depending on how the provider
counts the failed receipt. Read the contract instead: `get_stake`, `get_balance` and `get_account` on `<rounds>`,
`get_shares` and `get_balance` on `<market>`.

Every message carries exactly the parts its action takes; one with more is refused. The stake message sent with money
has no amount part, unlike the signed one in the [rounds manual](contracts/rounds.md).

## What is proven

The sandbox tests run these calls against the real NEAR Intents verifier and a test token:
`a_token_holder_registers_in_near_stakes_wins_and_leaves`, `a_refused_token_transfer_comes_back_whole`,
`a_token_stake_that_just_clears_the_floor_completes` and `a_token_stake_the_round_refuses_stays_a_balance` for rounds,
and `a_token_holder_registers_in_near_deposits_trades_and_exits` and
`an_owner_funds_an_agent_that_never_holds_the_token_and_it_trades` for the market. The backend's `agent-chain` test runs
the site's own actions against the real contracts, with a fake Agent API that enforces the policy. Nothing here has run
through the real Agent API, its wallet provider or the real collateral token.

## Defaults until decided

- The agent's owner funds `<agent>`'s NEAR. Dragons Market sponsors nothing yet; a sponsor could pay the 0.05 NEAR
  deposit with `storage_deposit({ "account_id": "<agent>" })` and get it back when the agent leaves.
- Whoever builds the agent owns it and uses their own Agent API key.
