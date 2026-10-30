# Dragons Market

Dragons Market is a prediction market on NEAR. Users buy Yes or No shares in an event, sell while
trading is open, or redeem after the result is final. Recurring crypto price rounds let users stake
Up or Down on a coin over a short interval. Funds are held in NEAR Intents and USDC is the collateral.

## How it works

- **Market** prices shares with a dynamic parimutuel cost function, so a market needs no seed.
- **Rounds** run Up/Down price rounds from a schedule; boundary prices are signed by a threshold of publishers.
- **Oracle** takes proposed results with a bond. A challenged result goes to a jury drawn from Council seats, with commit and reveal votes.
- **Council** handles NFT staking, jury seats and quarterly revenue claims.
- **Keeper** (`contracts/keeper/`) runs the transactions the contracts cannot start themselves: finalization, fee sweeps and round prices.
- **Backend** (`backend/`) indexes finalized chain data into Postgres and serves a read API with wallet sign-in.
- **Website** (`web/`) is a Next.js app with a wallet connection.

Administration is meant to sit behind a Trezu treasury on SputnikDAO. Platform revenue is split 75% to the
treasury and 25% to Council seats, which claim each UTC quarter once it is final.

## How this was built

Much of the code, tests and docs here were reviewed with AI coding assistants (Claude Code and Codex),
directed, reviewed and run by the team. The assistants were also used for structured security reviews of the
contracts; each finding has a regression test in `contracts/tests/tests/review_*.rs`.

## Repository

```text
contracts/   Rust contracts, sandbox tests, keeper scripts
backend/     TypeScript indexer and read API (Postgres)
web/         Next.js website and browser tests
docs/        Contract manuals, architecture and deployment notes
```

## Run locally

You need the pinned Rust toolchain (`contracts/rust-toolchain.toml`), `cargo-near`, Node.js 22.x and npm.

Build the contracts and start the local chain:

```bash
cd contracts
./build.sh
DEV_CHAIN_SECS=604800 cargo test -p tests --test dev_chain -- --ignored --nocapture
```

Wait for `DEV_CHAIN_READY`. In another terminal, start the website against that chain:

```bash
cd web
source scripts/use-node.sh
npm ci
DEV_SERVER_SECS=0 PORT=3400 bash scripts/dev-local.sh
```

Open [localhost:3400](http://localhost:3400).

The sandbox tests load a build of the NEAR Intents verifier from
[near/intents](https://github.com/near/intents) at commit `16d04f6ec4401263f8914638710260da50bb46b0`.
The build recipe and expected hash are in [docs/contracts/DEPLOY.md](docs/contracts/DEPLOY.md).

## Tests

From `contracts/`:

```bash
cargo test -p market -p oracle -p council -p rounds -p dpm -p upgrade --lib
cargo test -p tests
node --test keeper/*.test.mjs
```

From `web/`: `npm test`. From `backend/`: see [backend/README.md](backend/README.md).

## Status

The contracts are not deployed. The sandbox runs the real Intents verifier with test collateral; nothing
here has been run against mainnet. The treasury and DAO handover, a run against real USDC, and the live
funding and withdrawal flow are still open. Contract manuals and deployment checks are in
[docs/contracts/](docs/contracts/).
