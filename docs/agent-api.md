# Trading from an Agent API agent

For developers whose agent runs on the NEAR Intents Agent API and should stake in Dragons Market rounds or trade its
markets. The contracts are not deployed, so account names here are placeholders:

- `<rounds>` and `<market>`, the two contracts;
- `<token>`, the collateral token: `collateral_token_id` in either contract's `config`, without its `nep141:` prefix;
- `<agent>`, the agent's `near_account_id` from `GET /v1/agents/{agent_id}/wallet`.

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
