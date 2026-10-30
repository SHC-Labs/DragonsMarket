# Intents verifier proof

Date: 2026-10-20. Phase I1 of the Intents migration. No market, oracle, council or governance code
was changed. This document says what was run against the real verifier and what the run showed.

The test file is `contracts/tests/tests/intents_verifier.rs`. The receiver and payer fixture is
`contracts/mock-mt-receiver`. The verifier wasm is built outside the repository and is never
committed.

---

## Contents

1. [What was tested](#what-was-tested)
2. [Build recipe](#build-recipe)
3. [Claim table](#claim-table)
4. [Measured gas](#measured-gas)
5. [Pause and lock](#pause-and-lock)
6. [What the design must handle](#what-the-design-must-handle)
7. [What was not verified](#what-was-not-verified)

---

## What was tested

The real NEAR Intents verifier, `defuse` 0.4.5, from `github.com/near/intents` at commit
`16d04f6ec4401263f8914638710260da50bb46b0`, deployed in the near-workspaces sandbox next to
`mock-ft` (a NEP-141 with 6 decimals, standing in for USDC) and `mock-mt-receiver`. Every claim
below is checked against real receipts, not against a mock of the verifier.

---

## Build recipe

The verifier's `contracts/defuse/Cargo.toml` pins the build: image
`sourcescan/cargo-near:0.22.0-rust-1.97.1` (digest
`sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234`) and the command
`cargo near build non-reproducible-wasm --locked --features=contract --abi-features=abi,contract`.
The deployed `intents.near` reports the same command, commit and image digest in its
`contract_source_metadata`.

The binary the tests use is the reproducible docker build. Its sha256 is
`a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547`, which is the code hash
`intents.near` has on mainnet (`BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` in base58, read from
the RPC on 2026-10-20). So the sandbox runs the same bytes as mainnet.

```
SCRATCH=$(mktemp -d)
git clone https://github.com/near/intents $SCRATCH/intents-src
git -C $SCRATCH/intents-src checkout 16d04f6ec4401263f8914638710260da50bb46b0
cd $SCRATCH/intents-src/contracts/defuse
export PATH=$HOME/.cargo/bin:$PATH
cargo near build reproducible-wasm --out-dir $SCRATCH/intents-repro
mkdir -p contracts/target/intents
cp $SCRATCH/intents-repro/defuse.wasm contracts/target/intents/defuse.wasm
```

This needs docker, `cargo-near` 0.22.0 (the version CI installs) and a clean checkout. The first run
pulls the image, which took a few minutes here, and the build inside it took a few more. Result:

| Item   | Value                                                              |
| ------ | ------------------------------------------------------------------ |
| Size   | 1,297,551 bytes                                                    |
| sha256 | `a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547` |

Without docker, the same source builds on the host in about 30 seconds. The root of the clone has a
`rust-toolchain` file that names Rust 1.97.1, and rustup installs it on first use in its own
directory, so the workspace toolchain (1.99.0) is untouched.

```
cargo near build non-reproducible-wasm --locked --features=contract --abi-features=abi,contract --no-abi --out-dir $SCRATCH/intents-out
```

That result is 1,287,851 bytes with sha256
`66ca2458739d879215697a313233f6cfa9ee5e5a3654bcf97658abfaafd86850`. It differs from mainnet's bytes
(no embedded ABI, different build paths). The first full run of the tests used it, and the gas
figures below came out the same with the reproducible binary to within 0.1 TGas.

The test file reads `contracts/target/intents/defuse.wasm`. `contracts/target/` is already ignored
by git. Since phase I2, a missing file fails every sandbox test that needs it, with the build recipe
in the failure message: a silent skip would hide lost coverage, so CI must build the verifier before
it runs `cargo test -p tests` (the `sandbox` job in `.github/workflows/ci.yml` does). Run with
`-- --nocapture` to see the gas figures.

Run it:

```
cd contracts
./build.sh
cargo test -p tests --test intents_verifier -- --nocapture --test-threads=1
```

`./build.sh` now also builds `mock-mt-receiver`. The ten tests take about 75 seconds together.

---

## Claim table

Claims a to h are the ones the review makes in section 5.4. Evidence names the test that proves it.

| Claim                                                                                                                                                      | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a. `ft_transfer_call` with a `msg` naming a recipient credits `nep141:<token>` to that account                                                             | TRUE                | `deposit_credits_the_account_named_in_msg`. A deposit with `msg = bob` gave bob 10 USDC and alice 0. An empty `msg` credits the sender. The token itself sits in the verifier's token balance.                                                                                                                                                                                                                                                                                                                                                                      |
| b. The verifier does not notify a receiver on deposit                                                                                                      | TRUE, with one trap | `deposit_never_notifies_the_receiver`. A deposit with `msg = <contract>` ran no receipt on the contract. The old notify form `{"receiver_id":"<contract>","msg":"hello","min_gas":...}` also succeeded without any receipt on the contract, and the contract was credited. Unknown fields are ignored, not refused. A client that still sends the old form deposits money the contract never hears about.                                                                                                                                                           |
| c. `mt_transfer_call` calls `mt_on_transfer` with the true sender. Returning `[0]` keeps the funds. A panic or a malformed return refunds in full          | TRUE                | `transfer_call_notifies_and_refunds_on_a_bad_receiver`. The receiver saw `predecessor = verifier`, `sender_id = alice`, `previous_owner_ids = [alice]`, the token id and the amount. Returning `["0"]` kept the funds, and the verifier call returned `["30000000"]`, the amount kept. A panic, a string return and a list of the wrong length each left both balances unchanged, and the verifier call returned `["0"]`. `refund:4000000` left the receiver the rest. A refund above the amount was clamped. A receiver account with no contract refunded in full. |
| d. A contract with no keys pays out of its own Intents balance by a cross-contract `mt_transfer` with 1 yocto, with no signed intent and no registered key | TRUE                | `keyless_contract_pays_out_by_cross_contract_call`. The contract had its access keys deleted (checked with `view_access_keys`) and then paid alice 40 USDC and the rest of its balance. `mt_transfer_call` from the contract to another contract worked, and a panicking receiver sent the funds back to the contract. Paying more than the balance was refused.                                                                                                                                                                                                    |
| e. Such a contract needs nothing registered in the verifier                                                                                                | TRUE                | Same test. `public_keys_of(contract)` was empty before and after paying. `is_auth_by_predecessor_id_enabled(contract)` was true. It is also true for an account the verifier has never seen.                                                                                                                                                                                                                                                                                                                                                                        |
| f. A signed `transfer` with `{msg, min_gas}` relayed by `execute_intents` calls `mt_on_transfer` with `sender_id = signer`                                 | TRUE                | `signed_transfer_notifies_with_the_signer_as_sender`. An ed25519 key, a NEP-413 signature over the verifier's payload format, relayed by a third account. The receiver saw the signer's implicit account as `sender_id`. A replay failed. A forged signature failed. A receiver that panics did not fail the relayer's transaction: the signer was refunded inside the verifier with the memo `refund`, as the review says.                                                                                                                                         |
| g. Receiving an Intents balance needs no storage registration                                                                                              | TRUE                | `receiving_needs_no_storage_registration`. A transfer to an account that never touched the verifier, and that does not exist on NEAR, succeeded with 1 yocto attached. The verifier's storage grew by 683 bytes for the new account (819 bytes when a deposit created it). The verifier carries that cost, not the sender and not the receiver.                                                                                                                                                                                                                     |
| h. A plain deposit to a contract credits it with no callback, so a surplus is visible through `mt_balance_of`                                              | TRUE                | `unattributed_surplus_is_visible_without_a_callback`. The contract's `mt_balance_of` was 25 USDC and its own record of notifications was empty. A plain `ft_transfer` of the token straight to the verifier (the mainnet surplus case) left `mt_supply` unchanged while the verifier's token balance rose by the same amount, so that money is credited to nobody and cannot be seen through any `mt_balance_of`.                                                                                                                                                   |

Two further tests cover behaviour the design must handle: `gas_floors_of_the_verifier_calls` and
`pause_and_lock_stop_payouts_but_not_receipts`. A tenth, `token_id_must_be_the_nep141_form`, covers
token ids.

---

## Measured gas

Sandbox, default gas schedule, receiver is the trivial `mock-mt-receiver`. TGas is 10^12 gas.
"Burned" is gas actually used.

| Call                                                                             | Burned                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ft_transfer_call` deposit, whole transaction                                    | 8.1 (verifier 3.5)                                      |
| `mt_transfer` called directly by a user, least attached gas that succeeded       | 3 (2 failed)                                            |
| `mt_transfer` from a contract, whole transaction                                 | 5.8 (verifier 3.8, calling contract 1.5)                |
| `mt_transfer_call` to a receiver that keeps, whole transaction                   | 11.2 (verifier 7.5, receiver 1.2, calling contract 1.5) |
| `mt_transfer_call` to a receiver that panics, whole transaction                  | 12.0 (verifier 8.3, receiver 1.2)                       |
| `execute_intents` with one signed transfer and a notification, whole transaction | 10.5 (verifier 8.5, receiver 1.2)                       |

The callback overhead is the difference between the last two direct rows and a plain `mt_transfer`:
3.7 TGas more in the verifier (the resolve step) and 1.2 TGas in the receiver for a receiver that
only records the call. A real receiver adds its own work to that.

Gas floors, for a receiver that does almost nothing:

| Call                                            | Attached gas | Result                                     |
| ----------------------------------------------- | ------------ | ------------------------------------------ |
| `mt_transfer_call`                              | 20 TGas      | transaction failed, nothing moved          |
| `mt_transfer_call`                              | 21 TGas      | worked, receiver got 0.5 TGas              |
| `execute_intents` with the default notification | 50 TGas      | whole transaction failed, nothing executed |
| `execute_intents` with the default notification | 55 TGas      | worked                                     |

The receiver of `mt_transfer_call` gets what is left: the attached gas minus about 20.5 TGas (79.5
TGas at 100 attached, 279.5 at 300). For a signed transfer the receiver gets the attached gas minus
about 21.6 TGas. The default `min_gas` of a signed notification is 30 TGas and the floor is 5 TGas.
If the attached gas cannot cover `min_gas`, the whole `execute_intents` call fails, which is why 50
failed and 55 worked.

---

## Pause and lock

`pause_and_lock_stop_payouts_but_not_receipts`, with the test account holding the DAO and locker
roles:

- Pausing the feature `mt_transfer` made the contract's payout fail with nothing moved. It also made
  `mt_transfer_call` into the contract fail, because both share the feature key. After the unpause
  the payout worked.
- Locking the contract's account (`force_lock_account`, 1 yocto) made its payouts fail. A transfer
  call into the locked account still worked, so a locked market keeps receiving money it cannot pay
  out. After the unlock the payout worked.

---

## What the design must handle

1. Deposits never notify. A deposit to the market, in any message form, credits the market's Intents
   balance and nothing else. The market must treat every deposit as surplus, never as a funded
   position. Funding goes only through `mt_transfer_call`, a signed transfer with a notification, or
   the market's own token hook, which makes the deposit itself and credits the sender in its callback.
2. `mt_on_transfer` runs after the credit. A panic in it is safe and refunds in full. Returning a
   non-empty refund list is honoured and clamped.
3. The verifier call `mt_transfer_call` returns the amount kept, so an `Err` in the payer's callback
   means the verifier receipt itself failed (paused, locked, out of gas, balance too low). A
   receiver panic arrives as `Ok(["0"])`. This was observed from the verifier's side. It was not
   tested through a callback in a market contract, and the case where the verifier's own resolve
   receipt runs out of gas was not forced.
4. Attach gas for the market's own work plus about 21 TGas. Use 55 TGas or more for a relayed signed
   transfer with the default notification, or set `min_gas` and attach `min_gas` plus about 22 TGas.
   The receiver of `mt_transfer_call` gets nothing useful below about 21 TGas attached.
5. A pause manager can halt payouts and funding with one call, and a locker can freeze one account's
   payouts while it keeps receiving. The keeper should read `is_account_locked` and refuse to
   advertise funding while the market is locked. `is_account_locked` was read in the source and not
   run.
6. The verifier does not check that a receiver account exists. A transfer to a mistyped account
   succeeds and the money is lost to whoever owns that name. Payouts must go only to accounts the
   market's own records name.
7. Token ids are exact. `nep141:<contract>` is the only form that has a balance. The bare contract
   id and an upper-case prefix read as 0 and a transfer with a bare id is refused. The market must
   store the exact string.
8. The verifier pays for the storage of every Intents account it creates (about 0.007 NEAR each).
   The market's own per-user storage is a separate cost.

---

## What was not verified

- The real USDC contract. The sandbox token is `mock-ft`. The real token id is an implicit-account
  hex string, which sandbox cannot deploy to without a key. The id parser treats the part after
  `nep141:` as an account id, so the shape is the same, but the literal id was not run.
- Circle's blocklist and pause behaviour on NEAR (the review's open question 2).
- `auth_call` and `on_auth` in this phase. `contracts/tests/tests/intents_auth.rs` has since proved
  them (see "Signed actions" in [market.md](market.md)).
- That the contract's payouts stop working if predecessor authentication is switched off, and that
  `add_public_key` called by a contract registers a key. Both are read from the source only.
- The 1Click routes. They are not part of the verifier.
- Mainnet behaviour beyond the code itself. The bytes are the deployed ones, but the sandbox has its
  own gas schedule version, no real USDC and none of mainnet's roles or state.
