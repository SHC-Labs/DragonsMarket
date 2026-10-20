# Mainnet deployment checklist

This is the checklist for the code in this directory as it stands: market, oracle, council and governance, with NEP-141 token transfers. Nothing is deployed. Work through it in order, and do not skip a step because an earlier one looked fine. The owner decides each value in the starting parameters table; none of them is a recommendation backed by a mainnet run.

The accepted custody target is NEAR Intents (see `../intents-architecture.md`). If the contracts are changed to hold funds there, the token steps below (registration, funding, collateral) change with them and this list needs a new pass.

## 0. Gates before any deployment

1. The legal gate comes first: `../spec.md` section 18. Nothing on this list is worth doing before that route is settled, and selling or minting Council seats needs counsel (see `council.md`, "Things to know").
2. An outside audit. The only review so far is the self-review in `AUDIT.md`. One is required before mainnet money beyond a small capped test.
3. A testnet run of the whole procedure below, with the real token and the real keeper. The sandbox is a single shard and has never seen congestion, a slow RPC or a real wallet.
4. Everything on this page is for the four contract accounts. The website is out of scope here.

## 1. Build the code and record the hashes

Build from a clean commit of the source you will publish. A reproducible build compiles the committed code inside a docker image pinned in each contract's `Cargo.toml`, so anyone with docker and the same commit gets the same bytes.

```bash
cd contracts
./build.sh --reproducible        # needs docker and every change committed
cat target/near/HASHES.txt       # sha256 of the four wasm files
```

What was checked, and what was not:

1. The image is `sourcescan/cargo-near:0.22.0-rust-1.99.0` with digest `sha256:51ab40efd798eae26c0dc71180909303f10bb4988b15ce3a18522c5be06e277e`, in `[package.metadata.near.reproducible_build]` of the four contract crates. The template that cargo-near 0.22.0 itself generates (`cargo near new`) names an older image, `0.21.1-rust-1.96.0`. The `0.22.0-rust-1.99.0` tag matches both the cargo-near release and the toolchain pinned in `rust-toolchain.toml`. Its digest was read from the Docker Hub tag listing and confirmed by pulling the image. No cargo-near release note names this image, so it was not cross-checked against one. Check the digest yourself before you rely on it.
2. A reproducible build was run twice from two different clones of a scratch commit, and both gave the same four hashes. The scratch hashes are not release hashes. The build embeds the git commit into the wasm (NEP-330 build info), so the release hashes exist only once the release commit does. Run the build for the release commit on two machines and compare `HASHES.txt` before you stage anything.
3. Docker Hub is a third party. If the image tag were repointed, the digest in `Cargo.toml` would stop matching and the build would fail rather than change silently.

Publish `HASHES.txt` with the commit id. After deploying, each account's code hash must equal the published sha256 (the RPC shows it in base58) and `contract_source_metadata` must show the repository link, the version and the build info of that commit.

## 2. Create the accounts

Four contract accounts: market, oracle, council, governance. Also needed, and kept separate from each other: the business wallet, the operator, the keeper account, and the governance member accounts (5 members, hardware keys). Names are permanent, so pick them once.

Nothing runs on an account until you have decided who holds its first key and how that key is destroyed (steps 9 and 10).

## 3. Deploy and initialise in one batch

`new` is `#[private]`: only the contract account itself can call it, so the batch is signed by the account's own key. A deploy with no init in the batch leaves the contract unusable but not open to a stranger. Deploy governance first, because the others take it as their owner or hand ownership to it.

```bash
near contract deploy <account> use-file market.wasm \
  with-init-call new json-args '{ ...see "Starting it up" in market.md... }' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config mainnet sign-with-keychain send
```

The collateral token for market, oracle and council is native USDC, contract `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals, decided 2026-10-19; its Intents token ID is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`). Deposits in any other asset are converted to USDC at the Intents edge before they reach the contracts. Withdrawals always pay USDC, and the user bears the withdrawal fee and any swap fee. The conversion cost, the refund path for a failed conversion and the `ft_transfer_call` deposit route have not been measured; do that on mainnet with small funds before raising any cap. The arguments of each `new` are in the "Starting it up" section of its manual. Read them back with `config` straight after, and check the owner, the oracle and market links, that the collateral token is exactly that contract on all three, and the network word (`network` must be `mainnet`, since a price signed for one network is useless on another).

## 4. Register the accounts with the collateral token

The token has to know every account that will receive it before it can pay it. Call the token's `storage_deposit` with `registration_only` for market, oracle, council and the business wallet, and for governance if it will ever hold tokens. A missing registration makes sweeps and withdrawals fail and the amount come back as owed.

## 5. Fund the accounts for storage

Every record a contract keeps is paid for out of that contract's own NEAR balance, at 1 NEAR per 100 KB. An account that cannot cover a write fails the write. In the oracle that means no case can open.

| Account | What grows | Fund with |
|---|---|---|
| market | Each market (text up to about 3 KB, a 120 point price history), each registered user | Code plus headroom for the market count you expect, and the 0.05 NEAR registration deposits users pay |
| oracle | Each case (up to about 0.25 NEAR in the worst case, with 21 reasons of 1,000 bytes), each claimable entry | The most generous of the four |
| council | Each staked seat, a few hundred bytes, up to 1,000 | Code plus 1,000 seats |
| governance | Each proposal, arguments up to 4 KB, never deleted | Code plus a long run of proposals |

The code of each is about 2 to 3 NEAR. Fund each account with its code, its expected peak data and at least the keeper's margin on top (below). Then run the check and read its margin lines:

```bash
node keeper/keeper.mjs check --rpc URL --market M --oracle O --council C --governance G
```

For each account it prints the balance minus the storage cost of the bytes in use (1e19 yoctoNEAR a byte), and it reports a problem under the margin. The default margin is 5 NEAR, which pays for 500 KB of new state. Change it with `--min-margin NEAR`. Run it from a timer, not only once.

## 6. Configure, before ownership moves

Set everything while the deployer still owns the contracts, then hand over, because after the handover each change is a vote and a timelock. The values are in the starting parameters table below. In order:

1. Oracle: publishers (at least `price_threshold` of them, each a dedicated key, see "Publisher key hygiene"), the threshold, the jury size, the challenge window, the panel deadline, the draw window, the draw delay and the minimum proposal time (`add_publisher`, `set_price_threshold`, `set_jury_size`, `set_window_ms`, `set_panel_deadline_ms`, `set_draw_window_ms`, `set_draw_delay_blocks`, `set_min_proposal_ms`). The window settings reach markets registered afterwards, so set them before the first market.
2. Oracle: the bond (`set_bond`), above a floor and scaled with the market size you will allow.
3. Council: the cooldown and the seat cap (`set_cooldown_ns`, `set_max_seats_per_account`). The cooldown must be at least the longest a seat can serve: the challenge window, plus both rounds' draw window, commit and reveal, plus the 30 second buffer. With the starting values that is about 102 hours, so use 7 days.
4. Market: the operator (`set_operator`), the fee rate and the creation fee if they differ from 2% and 1 token, and the fee recipients (the council as revenue pool, the business wallet).
5. A market needs `resolve_by` at least `min_resolve_gap_ns` (shown in the oracle's `config`) after it closes. With the starting values that is about 102 hours (the challenge window, then two rounds of draw window and panel deadline, then the buffer) plus the minimum proposal time.

## 7. The Council NFT collection

Staking a seat is allowed only for token ids on the council's allowlist while it is on. The allowlist is the protection against someone minting seats to take the jury pool, so it only works if the collection itself is closed:

1. A fixed supply, written into the collection's code.
2. Minting closed: no account, including the collection owner, can mint another token.
3. The collection's code hash published, and checked against the source.

Then open the allowlist with `allow_tokens` in batches of up to 100, or one `set_token_range(first, last)` for a collection with plain decimal ids. `set_allowlist_enabled` turns it on and off. `007`, `+7` and a padded number are refused by the range on purpose.

The council needs enough different seat holders for a dispute to reach its second jury. A first jury of `n` is followed, when it does not decide, by a second of `min(2n + 1, 21)`, drawn from other accounts than the first jury, the proposer and the challenger. That takes `n + min(2n + 1, 21) + 2` different holders:

| Jury size | Second jury | Holders needed |
|---|---|---|
| 3 | 7 | 12 |
| 11 | 21 | 34 |
| 21 | 21 | 44 |

With fewer, a dispute can still be drawn if the holders cover the first jury plus the two parties, but a first jury that does not decide cannot escalate, and the keeper check says so. With fewer holders than `n + 2` a dispute whose parties hold seats cannot be drawn at all. Do not open markets until the check is quiet. The seat cap does not stop one person using many wallets (see "Things to know" in `council.md`), so 34 holders is 34 accounts, not 34 people.

## 8. Hand ownership to governance

For market, oracle and council:

1. The owner calls `propose_owner(<governance account>)`.
2. A governance member proposes a `function_call` to `accept_owner` on that contract (no deposit, 5 TGas or more), the members vote, the timelock passes, and anyone executes with the call's gas plus 14 TGas attached.
3. Read `config` on the contract and check `owner` is the governance account and `pending_owner` is empty.

Read back all three. Check that governance's own member list and threshold are what you intended, since everything the owner can do is now controlled by whoever holds a threshold of member keys. Set the operator to a fast key that cannot move money (see `market.md`, "Roles").

## 9. Prove the upgrade path on every account

`seal` is refused until `upgrade_proven` is true, so each account needs one upgrade through `migrate`:

1. Build a second version of the code whose hash differs (a version bump is enough) and stage it with `stage_code`, attaching 100 TGas and the deposit for its size. Confirm with `is_staged`.
2. Propose a `function_call` to `upgrade` with `{"code_hash": "<base58>"}`, 100 TGas or more, or an `upgrade_self` for governance itself. Vote, wait out the timelock, execute.
3. Check `config`: `upgrade_proven` is true, `state_version` is right, and the `migrated` event is in the transaction. If the upgrade failed, the old code is still there and the staged copy is gone, so stage again.

The timelock is the users' exit window: `withdraw`, `redeem`, `unstake` and `claim` never pause. Set it to at least 72 hours before real money is in.

## 10. Seal

Delete every access key on all four accounts, through governance, with the `seal` action (on governance itself) and a `function_call` to `seal` on the other three. Then check each account has none:

```bash
curl -s -H 'content-type: application/json' $RPC -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"<account>"}}'
```

The `keys` list must be empty on all four. From then on only a governance upgrade can change the code. A sealed contract with a broken upgrade path cannot be fixed, which is why step 9 comes first.

## 11. Publish and verify

Publish the hashes, the commit, the image digest and the NEP-330 link. Confirm each account's `contract_source_metadata` matches: `link` is the repository, `version` is the crate version, `standards` lists `nep330`, `nep297` and, for market, `nep145`, and the build info names the commit. A hash on chain that does not match the published one means stop.

## 12. Keeper, publisher and monitoring

The keeper (`keeper/keeper.mjs`) sends the calls that only happen when someone calls them. Run it from a timer on a machine that is not a laptop.

1. A keeper account with a little NEAR. Give it function-call access keys and no full-access key on the machine that runs the keeper. One key for oracle with the methods `finalize`, `resolve_draw`, `retry_apply`, `retry_unlock`, `resolve_by_deadline`, and one for market with `sweep_fees`, each with a small allowance. The commands are in the header of `keeper.mjs`. Pass them as `KEEPER_ORACLE_KEY` and `KEEPER_MARKET_KEY` or with `--oracle-key-file` and `--market-key-file` (mode 0600). A key is never taken from the command line.
2. `--state-file` keeps the run time flat as markets pile up.
3. The keeper does not submit signed prices. That is the publisher service, which does not exist yet.

Monitor, with an alert on each:

| What | How |
|---|---|
| Storage margin of the four accounts | `keeper.mjs check` on a timer, non-zero exit |
| Collateral invariant of open markets | `check_invariant(market_id)` returns true |
| Cases settleable and not finalized for over an hour | The keeper should have done it; if it did not, the keeper is down |
| Draw failures | The oracle's `draw_failed` event, and a disputed case with no jury after `draw_after_height` |
| Fee transfers that failed or were lost | The market's `fee_transfer_failed` and `fee_transfer_unresolved` events (the second needs the owner's `reconcile_revenue`) |
| Governance proposals | The `approved` event: a bad change is public for the whole timelock and nothing else alerts anyone |
| Publishers | `publisher_added` and `publisher_removed` on the oracle |
| Keeper key allowance | `view_access_key` for each scoped key |

## 13. Open in steps

Mainnet starts with a hard cap on total value locked and on each user's deposits (`../spec.md`, launch limits), raised in steps. The contracts have no cap on the value in one market apart from the size of a pool, so the cap is what the operator seeds and what the deposit route allows. Raise a cap only after the monitoring list above has been quiet for a full dispute cycle, about the case span in the cooldown note.

## Starting parameters

Starting values for the owner to argue with. They come from section 6.3 of the 2026-10-19 outside review (`contract-and-website-review-2026-10-19.md`) and from `../spec.md` section 21.

| Parameter | Starting value | Notes |
|---|---|---|
| Jury size | 11 at launch, 21 later | 3 is captured too easily for real money. 21 needs 44 different holders. |
| Challenge window | 2 hours for events, 30 to 60 minutes for price markets | Price answers have objective evidence and `price_threshold` signatures. |
| Commit and reveal | 24 hours each, counted from the draw | `panel_deadline_ms` is the two together, 48 hours. |
| Draw window | 2 hours | |
| Draw delay | 3 to 5 blocks | |
| Bond | At least a floor, and scaled with the market size cap | One fixed bond cannot scale with market size. The review cites about 750 USD as a typical proposal bond elsewhere. |
| Unstake cooldown | At least the case span, or 7 days | About 102 hours with the values above. |
| Seat cap per account | 5 | Limits revenue concentration only. |
| Code upgrade timelock | At least 72 hours | The users' exit window. |
| Governance threshold | At least 3 of 5 | A threshold of 1 is a single key with more steps. |
| Fee rate, creation fee | 2%, 1 token | The code's own starting values. The ceilings are 5% and 10 tokens. |

## Publisher key hygiene

A publisher signs plain text, so a price signature is only safe from being reused as something else while the key is used for nothing else.

1. A publisher key is a dedicated ed25519 key. It is never added as an access key to any account.
2. It lives in an HSM or a cloud KMS, not on a disk.
3. Rotate it with `add_publisher` for the new key, then `remove_publisher` for the old one. The owner adds; the operator or the owner removes.
4. The `proposed` event of a price answer lists the verified keys, and `verified_signers` returns them, so a signer is auditable after the fact without an archival node.
5. Anyone holding a valid signed price can submit it first and take the proposer slot (known, in `AUDIT.md`). Submitting at the observation time is the publisher service's job.

## What this list does not cover

The website. The publisher service. The Intents custody migration. A testnet soak. A multi-shard run. An outside audit.
