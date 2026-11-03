---
name: dragons-market
description: Stake on Dragons Market price rounds for the agent account an owner connected to you. Use when the owner asks you to trade, stake, claim, withdraw or cash out on Dragons Market, or to report the agent's balances, open rounds or history.
---

# Dragons Market

Dragons Market runs price rounds. Each series follows one asset price, and each round asks whether the price ends higher (up) or lower (down) than it started. You stake on one side; when the round has an outcome, a winning stake claims its share of the round, and a losing stake claims nothing.

You act for one agent account. Its owner created it, funds it from their own wallet, and set the limits you work within. You never hold keys, and you never see the owner's wallet.

## Where the money is

- **Rounds balance**: what you can stake. The owner funds it directly. Claims pay winnings back into it.
- **NEAR Intents balance**: where a withdrawal from rounds lands.
- **The owner's wallet**: the only place a cash out can go.

Money moves in one direction only: rounds balance, then NEAR Intents balance, then the owner. Nothing you do can send it anywhere else.

## Workflow

1. `get_agent`: read the balances, whether the agent is frozen, and the owner's limits with what is left of them.
2. `list_rounds`: pick a series and its `next_round`, and note `min_stake` and `max_open_stakes`.
3. `quote_stake`: ask what a stake would buy. It returns `shares` and `min_shares`.
4. `stake`: pass the same series, round, side and amount, the `min_shares` from the quote, and a new `request_id`.
5. Later, `list_operations`: find confirmed stakes in rounds that have ended, and `claim` each one.
6. When the owner wants their money: `withdraw` from rounds, then `cash_out`.

Amounts are decimals of the collateral token, such as `5` or `2.5`. Shares and `min_shares` are whole numbers; copy them exactly.

## request_id

Every action takes a `request_id` you choose: 8 to 64 letters, digits, `-` or `_`.

- Use a new `request_id` for each new action.
- To retry an action, call it again with the same `request_id` and exactly the same arguments. Dragons Market sends it once, however many times you ask.
- Never retry an action under a new `request_id`. That is a second action, and it can stake twice.

## Outcomes

Each action returns an `outcome`:

- `done`: it happened on chain.
- `refused`: it did not happen, and nothing more will come of it.
- `settling`: it was sent and has not settled yet. It may still land. Call the same tool again with the same `request_id` and arguments until it is `done` or `refused`.
- `needs_owner`: Dragons Market could not prove what happened, so it stopped the action for the owner to check. It may have landed. Do not retry it under any `request_id`; tell the owner, and leave that money alone until they say it is settled.

A tool error with `retry_same_request_id: true` also means the action may have been sent: retry it the same way. Any other error means nothing was sent.

## Limits and refusals

- `stake_over_limit`: the stake is above the owner's limit for one stake.
- `daily_limit_reached`: the owner's limit for the last 24 hours is used up. A stake counts against it once admitted, even if it then fails.
- `agent_frozen`: the owner froze the agent. You can still claim, withdraw and cash out, but not stake.
- `grant_required`: the owner has not authorized Dragons Market, or stopped it.
- `access_token_invalid`: your access was revoked or has expired. Ask the owner for new access.
- `operation_idempotency_conflict`: that `request_id` was used for a different action. Choose a new one.

## Rules

- Stake only what the owner asked for, within the limits `get_agent` reports.
- Quote before every stake, and never invent `min_shares`.
- A round you already staked takes more stake only on the same side.
- Report what happened in plain terms: amounts with the token, the round, and the outcome.
