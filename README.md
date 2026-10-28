# Dragons Market

Dragons Market is a prediction market built on NEAR. Users buy Yes or No shares in an event,
sell while trading is open, or redeem after the result is final. Each market has a published rule,
result source and closing time. Staked Dragon NFTs make their owners eligible to serve on dispute
juries and share in platform fees.

The product story and growth plan are in [PITCH.md](PITCH.md).

## How it works

The market contract prices shares with a dynamic parimutuel cost function, so a market needs no
seed and opens for trading as soon as it is registered. An oracle accepts proposed results
and challenges. A challenged result goes to a jury drawn from eligible Council seats; jurors commit
their votes before revealing them. The Council contract handles NFT staking and reward accounting.
The accepted administration target is a Trezu treasury backed by SputnikDAO. The custom
`governance` contract is retired from the
target architecture. Current administrative work is described in
[the Trezu handoff](docs/contracts/governance.md).

NEAR Intents is the intended token-holding layer. Funding should arrive through a supported route,
be committed as collateral for a position inside Intents, and become available again after a sale
or settlement. Market and Council source now use Intents-held transfers, the market splits fees between
the treasury and the Council with a recorded sweep per leg, and the Council pays quarterly claims once
(2026-10-21). The website's financial integration, the real treasury and a run against the real USDC
remain incomplete.
The local sandbox uses the real Intents verifier with test collateral. Mainnet funding and
withdrawals have not been established by these local tests.

The website includes markets, market details, a wallet watchlist, Council membership and disputes,
partnerships, and a portfolio. It has a shared purple palette, light and dark themes, and layouts
for phones and larger screens. The displayed NFT portraits are part of a larger collection.

## Accepted architecture

Owner decision, 20 October 2026. This is the implementation target, not a report of deployment.

| Area | Decision |
| --- | --- |
| Administration | Use Trezu/SputnikDAO instead of deploying or maintaining our custom `governance` contract |
| Token holding | Keep trading funds, committed backing, bonds and reward funds in NEAR Intents |
| Earned platform revenue | Allocate 75% to the Trezu treasury and 25% to Council-controlled NFT-holder rewards |
| Holder payouts | Eligible holders claim through the Council on a quarterly schedule; no manual payout-wallet route |
| Disputes | Keep Council juries and oracle rules separate from treasury member voting |

The Council tracks entitlements by UTC calendar quarter while its reward backing remains in Intents.
A seat earns for the time it was staked in the quarter, and claims each quarter once after the
quarter is final (7 days after it ends to start). The 30-day stream is gone.

Owner decision, 21 October 2026: sensitive administrative changes use Trezu/Sputnik member
approvals, and the DAO voting period is the only delay. SputnikDAO executes a proposal at the
approval that reaches its threshold, so the period gives public visibility and a deadline, not an
exit window after approval. Withdraw and redeem never pause, upgrades use publicly staged code, and
deployment keys are removed only after a proven upgrade. The owner handover still needs review
before deployment.

See [the accepted architecture](docs/intents-architecture.md) for the migration requirements and
[the product specification](docs/spec.md#7-architecture-and-administration) for review scope.

The [product goal](docs/spec.md#1-product-goal) and
[requirements map](docs/spec.md#requirements-to-implementation-map) connect these
decisions to contract capabilities and acceptance checks. Missing methods are implementation
work; the existing prototype does not set the limit of the product.

## Repository

```text
contracts/   Rust contracts, sandbox tests and keeper scripts
web/         Next.js website, components, assets and browser tests
docs/        Architecture, plans, contract manuals and reviews
design/      Branding and design assets
marketing/   Launch campaign, images, copy and metrics
README.md    Project overview and development setup
PITCH.md     Product idea, differentiation and growth plan
```

Git configuration and GitHub Actions remain in the usual hidden files and folders.

Start with [docs/spec.md](docs/spec.md) for decisions and current gaps.
[docs/intents-architecture.md](docs/intents-architecture.md) defines custody/control boundaries;
[docs/hackathon-plan.md](docs/hackathon-plan.md) defines submission evidence.
[NEAR-RESEARCH.md](NEAR-RESEARCH.md) is a reusable ecosystem reference, not a product roadmap.

Contract manuals and the historical audit record are in `docs/contracts/`. The launch campaign is in
[marketing/launch-campaign-21-days/CAMPAIGN.md](marketing/launch-campaign-21-days/CAMPAIGN.md).

## Dependencies

| Part              | Dependencies                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| Contracts         | Rust 1.99.0, `near-sdk` and `near-contract-standards` 5.29.1            |
| Contract builds   | `cargo-near` 0.22.0, WebAssembly target; Docker for reproducible builds |
| Sandbox tests     | `near-workspaces` 0.23.0, Tokio, a local Intents verifier build         |
| Website           | Node.js 20.9 or newer, npm, Next.js 16.4 and React 19.3                 |
| UI                | TypeScript, Tailwind CSS 4, Visx charts and Iconsax icons               |
| Wallet connection | `@hot-labs/near-connect`                                                |
| Website checks    | Vitest, Playwright, axe and ESLint                                      |

Exact package versions are recorded in `contracts/Cargo.lock` and `web/package-lock.json`.
The Rust toolchain and WebAssembly target are pinned in `contracts/rust-toolchain.toml`.

The active contract workspace contains `market`, `oracle`, `council` and the shared `upgrade`
crate. Custom governance is removed from the workspace, builds, CI and active sandbox fixtures.
Trezu/SputnikDAO administration helpers prepare wallet proposals in `contracts/keeper/treasury.mjs`;
they do not sign or submit transactions. The treasury has not been created, live ownership is
unconfigured, and the helper is an allow-list of the owner methods of the three contracts that has not
been run against a real DAO.

`mock-ft`, `mock-nft` and `mock-mt-receiver` are test fixtures. The scripts in
`contracts/keeper/` advance contract actions that need a transaction, such as finalization and fee
sweeps; they require their own configuration and keys.

## Run locally

Run the following commands from the repository root. You will need the pinned Rust toolchain,
`cargo-near`, Node.js 22.23.4 or newer in the 22.x line, and npm. The sandbox suite also needs the Intents verifier described below.

Build the contracts and start the local chain in one terminal:

```bash
cd contracts
./build.sh
DEV_CHAIN_SECS=604800 cargo test -p tests --test dev_chain -- --ignored --nocapture
```

Wait for `DEV_CHAIN_READY`. The harness writes its RPC endpoint and deployed account IDs to
`contracts/dev-chain.json`, which is local runtime state regenerated by the harness.

In another terminal, start from the repository root:

```bash
cd web
# Select web/.node-version with your version manager, or the project-local runtime:
source scripts/use-node.sh
npm ci
DEV_SERVER_SECS=0 PORT=3400 bash scripts/dev-local.sh
```

Open [localhost:3400](http://localhost:3400). The script reads the chain descriptor and configures
the website for that sandbox. Start the chain before the website, and restart the website if the
chain is replaced. `DEV_SERVER_SECS=0` keeps the server running until you stop it.

For another deployment, set `NEXT_PUBLIC_NETWORK`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_MARKET_ID`,
`NEXT_PUBLIC_ORACLE_ID` and `NEXT_PUBLIC_TOKEN_ID` before starting or building the website.
The public environment settings select the contracts; they do not contain signing keys.

### Intents verifier

The integration tests load `contracts/target/intents/defuse.wasm`. It is built from
[near/intents](https://github.com/near/intents) at commit
`16d04f6ec4401263f8914638710260da50bb46b0` and is not committed here.

With Docker and `cargo-near` 0.22.0 installed, build it from a clean upstream checkout.
Start these commands from the repository root:

```bash
PROJECT_ROOT="$(pwd)"
INTENTS_BUILD="$(mktemp -d)"
git clone https://github.com/near/intents "$INTENTS_BUILD/intents"
git -C "$INTENTS_BUILD/intents" checkout 16d04f6ec4401263f8914638710260da50bb46b0
mkdir -p "$PROJECT_ROOT/contracts/target/intents"
(
  cd "$INTENTS_BUILD/intents/contracts/defuse"
  cargo near build reproducible-wasm --out-dir "$PROJECT_ROOT/contracts/target/intents"
)
```

The expected SHA256 is
`a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547`.
Verifier tests exercise deposits, transfers, receiver callbacks and refunds in the sandbox.
They do not exercise a real cross-chain bridge or production collateral.

## Checks and builds

From `contracts/`:

```bash
cargo test -p market -p oracle -p council -p upgrade
cargo test -p tests
node --test keeper/keeper.test.mjs keeper/treasury.test.mjs
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Counts after the fee split and quarterly claims (2026-10-21): unit tests market 172, oracle 115, council 106,
upgrade 11; sandbox tests 160 in 22 files (10 verifier proof tests, 7 market and Council money-path tests, 9
oracle money-path tests, 10 source guards, 7 keeper tests, 5 quarterly claim tests; the `dev_chain` harness is
ignored); keeper node tests 52 (27 keeper, 25 treasury helper). A missing
`contracts/target/intents/defuse.wasm` fails the sandbox tests with the build recipe instead of skipping
them, so CI builds it first.

These commands cover the application contracts. Owner/upgrade tests use an explicitly labelled
local account fixture, not simulated DAO approvals. Real Sputnik proposal execution, expiry and
owner handover still need dedicated integration evidence. No retired controller is deployed.

Run `./build.sh` before the sandbox tests. For reproducible builds of the three application contracts,
use `./build.sh --reproducible`; that path requires Docker and a clean committed working tree.
GitHub Actions runs the contract checks in `.github/workflows/ci.yml`.

From `web/`:

```bash
npm run lint
npm test
npm run tokens
npm run build:dev
npm run e2e
```

`build:dev` exports the website against the running sandbox. Playwright serves that export on
port 3390. `npm run serve` serves it separately. Every design value lives in `web/design/tokens.json`;
`npm run tokens` generates the stylesheet and the DESIGN.md front matter and checks contrast.
`npm run check:brand` fails on code that bypasses the tokens. The brand guide is
[design/BRAND.md](design/BRAND.md).

The project is under development. Production settlement, the complete funding and withdrawal
flow, an external security audit and launch requirements remain open work.

## Repository alignment, 21 October 2026

The active spec and implementation handoffs now share one direction. Old stack/NFT research
drafts, custom-controller source snapshots, unused NFT sets, template icons and abandoned UI
components have been removed. Dated security/legal reviews and policy copies remain evidence.

Current release gaps are the real treasury and its owner handover and a run of the fee split and the
claims against the real USDC and a real DAO,
external funding/identity/exit integration, and backend recovery.
Financial UI actions remain disabled until those interfaces are reviewed.

Contract code, tests, build scripts and CI were inspected without modification during this pass.
Claude owns that work; Codex owns website cleanup and the reviewed frontend integration.
