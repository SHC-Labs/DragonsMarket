<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="Dragons Market" width="640">
  </picture>
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> &bull;
  <a href="#contracts">Contracts</a> &bull;
  <a href="#run-it-locally">Run it locally</a> &bull;
  <a href="#tests">Tests</a> &bull;
  <a href="#status">Status</a> &bull;
  <a href="docs/contracts/DEPLOY.md">Deployment</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Strict%201.0.0-blue.svg" alt="License: PolyForm Strict 1.0.0"></a>&nbsp;&nbsp;&nbsp;
  <img src="https://img.shields.io/badge/chain-NEAR-23734d.svg" alt="Chain: NEAR">&nbsp;&nbsp;&nbsp;
  <img src="https://img.shields.io/badge/collateral-USDC%20via%20NEAR%20Intents-2775ca.svg" alt="Collateral: USDC via NEAR Intents"> <br>
  <img src="https://img.shields.io/badge/contracts-Rust-orange.svg" alt="Contracts: Rust">&nbsp;&nbsp;&nbsp;
  <img src="https://img.shields.io/badge/status-not%20deployed-lightgrey.svg" alt="Status: not deployed">
</p>

&nbsp;

## What it is

A prediction market on NEAR where the rules come first. 
Every market publishes its rule, result source and closing time before anyone trades.
Funds sit in NEAR Intents. Disputed results go to a jury of Dragon holders.

Users buy Yes or No shares in an event, sell while trading is open, and redeem once the result is final.
A second product, price rounds, lets users stake Up or Down on a coin over a short interval; winners share
the pool. Platform revenue is split 75% to the treasury and 25% to the holders of staked Dragon NFTs,
who claim it each quarter.

Nobody has to trust the operator with a result. A proposed result carries a bond, anyone can challenge it,
and a challenged result goes to a jury drawn from staked Dragons, with committed and then revealed votes.

&nbsp;

## How it works

| Part | What it does |
| --- | --- |
| **Market** | Prices shares with a dynamic parimutuel cost function, so a market needs no seed money and opens as soon as it is registered. |
| **Rounds** | Recurring Up/Down price rounds. Boundary prices are signed by a threshold of publishers and checked on chain. |
| **Oracle** | Takes proposed results with a bond, handles challenges, and draws and pays the jury. |
| **Council** | Handles Dragon NFT staking, jury seats and the quarterly revenue claims. |
| **Keeper** | Sends the transactions the contracts cannot start by themselves: finalization, fee sweeps and round prices. |
| **Backend** | Indexes finalized chain data into Postgres and serves a read API with wallet sign-in. |
| **Website** | A Next.js app with a wallet connection. |

Collateral, bonds and rewards are held as USDC in the contracts' accounts inside
[NEAR Intents](https://github.com/near/intents), not as plain token balances. Withdrawals and redemptions
keep working while trading is paused. Administration is meant to sit behind a Trezu treasury on SputnikDAO, with upgrades staged in public
and access keys removed after a proven upgrade.

&nbsp;

## Contracts

Each contract has a manual with its methods, events, limits and failure modes.

| Contract | Manual |
| --- | --- |
| Market | [docs/contracts/market.md](docs/contracts/market.md) |
| Rounds | [docs/contracts/rounds.md](docs/contracts/rounds.md) |
| Oracle | [docs/contracts/oracle.md](docs/contracts/oracle.md) |
| Council | [docs/contracts/council.md](docs/contracts/council.md) |
| Custody and Intents | [docs/intents-architecture.md](docs/intents-architecture.md) |
| Product specification | [docs/spec.md](docs/spec.md) |

&nbsp;

## Run it locally

You need the Rust toolchain pinned in `contracts/rust-toolchain.toml`, `cargo-near`, Node.js 22 and npm.

Build the contracts and start a local chain:

```bash
make build
cd contracts
DEV_CHAIN_SECS=604800 cargo test -p tests --test dev_chain -- --ignored --nocapture
```

Wait for `DEV_CHAIN_READY`. In a second terminal, start the website against that chain:

```bash
cd web
source scripts/use-node.sh
npm ci
DEV_SERVER_SECS=0 PORT=3400 bash scripts/dev-local.sh
```

Open [localhost:3400](http://localhost:3400). The sandbox tests also load a build of the NEAR Intents verifier
from [near/intents](https://github.com/near/intents) at commit `16d04f6ec4401263f8914638710260da50bb46b0`;
the recipe and expected hash are in [docs/contracts/DEPLOY.md](docs/contracts/DEPLOY.md).

&nbsp;

## Tests

```bash
make test      # unit tests, the sandbox suite against the real compiled WASM, and the keeper tests
make clippy    # clippy with warnings denied
```

The sandbox suite runs every contract in a local NEAR chain with the real Intents verifier. It takes more than an
hour, because the dispute tests move chain time forward by hours. Website checks run from `web/` with `npm test`;
backend setup is in [backend/README.md](backend/README.md).

Security reviews of the contracts are kept as regression tests: each finding has a failing test first, then the fix.
They live in `contracts/tests/tests/review_*.rs`.

&nbsp;

## Status

The contracts are not deployed. The sandbox runs the real Intents verifier with test collateral, and nothing here
has been run on mainnet. Still open: the real treasury and DAO handover, a run against real USDC, and the live
funding and withdrawal flow. The remaining limits and decisions are in the contract manuals.

&nbsp;

## How this was built

The code and tests here were reviewed with AI coding assistants (Claude Code and Codex), directed,
reviewed and run by the team. The assistants were also used for structured security reviews of the contracts.

&nbsp;

## License

Released under the [PolyForm Strict License 1.0.0](LICENSE). The source is public for reading and evaluation;
commercial use, copying into other projects, changes and redistribution are not permitted without written permission.
