# Dragons Market: agent instructions

Prediction market on NEAR. Rust contracts in `contracts/`, Next.js website in `web/`, decisions and
manuals in `docs/`, brand in `design/`, campaigns in `marketing/`. Start with
[docs/spec.md](docs/spec.md) for product decisions and [README.md](README.md) for setup.

## Website and anything visual

- The brand is defined in [design/BRAND.md](design/BRAND.md) (why and voice) and
  [web/DESIGN.md](web/DESIGN.md) (tokens, components, do's and don'ts). Read DESIGN.md before
  changing UI. The live reference is the `/brand` route.
- Every raw design value lives in [web/design/tokens.json](web/design/tokens.json). After editing
  it, run `npm run tokens` in `web/`. Never edit `app/tokens.generated.css` or the DESIGN.md
  front matter by hand.
- Reuse the components listed in DESIGN.md. Icons come only from `web/components/icons.tsx`.
- Before calling UI work done, in `web/`: `npm run check:brand`, `npm test`, `npx tsc --noEmit`,
  `npx eslint app components lib`. Then prove it in the browser with `.claude/skills/verify`.
- Marketing images and copy follow [design/MARKETING.md](design/MARKETING.md).

## Writing

Project documents follow [docs/DOCUMENTATION-STYLE.md](docs/DOCUMENTATION-STYLE.md): a specific
title, a metadata table, the outcome first, plain punctuation and no em dashes.

## Contracts

Format, lint and test from `contracts/`: `cargo fmt --all --check`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo test -p market -p oracle -p council -p upgrade`.
