# Dragons Market website

Next.js frontend for markets, individual market detail, Council membership and disputes, watchlists, partnerships and portfolios.

## Custody and integration status

The accepted target is [NEAR Intents token custody](../intents-architecture.md): available funds, controlled market backing, bonds and fee/reward balances stay inside Intents until an authorized external exit. Dragons Market contracts enforce positions, liabilities and outcomes. This integration is pending; the current view adapters target the existing NEP-141 prototype and financial writes stay disabled until the reviewed interfaces and receipts are wired.

The frontend must distinguish a connected wallet, its verified Intents account, and the account that owns positions/juror rights. Do not treat `get_balance` on the legacy market as an Intents balance or create a second spendable balance from a provider status. Show available, committed, pending and reward states, with resumable operations and verified completion. The contract team must define the DTOs and supported authorization flow first.

See [WEBSITE-REVIEW-RESPONSE.md](WEBSITE-REVIEW-RESPONSE.md) for the earlier frontend review dispositions and [hackathon-plan.md](../hackathon-plan.md) for the funded-trade/dispute/exit demo gates.

## Local development

From this directory, against an already running local chain with its generated `contracts/dev-chain.json`:

```bash
bash scripts/dev-local.sh
```

The script reads the generated chain configuration and starts the site at [localhost:3400](http://localhost:3400), defaulting to a two-hour lifetime. It does not start the chain or an Intents service. `PORT` can override the port. Never publish generated account/key files.

For an explicitly configured environment, `npm run dev` starts Next.js with the supplied `NEXT_PUBLIC_*` values. Local mocks/sandbox demonstrate UI and contract behavior; they are not evidence of real cross-chain Intents execution.

## Checks

```bash
npm run tokens
npx tsc --noEmit
npm run lint
npm test
npm run e2e
```

Browser suites have different fixture/environment requirements. A passing mocked suite does not establish real-wallet signing, funded settlement or final destination payout. Record the environment and exact checks used for each integration change.

## Design

Preserve the professional minimal studio layout, persistent light/dark themes, purple venue surfaces and a complete mint/forest palette for Council. All pages share IBM Plex Sans typography and the Dragons Market crest. Council includes its header, footer and browser chrome in the green theme; the rest of the venue retains purple. `design/palette.json` is the canonical color source; `npm run tokens` generates `app/palette.css` and checks configured contrast pairs.

Market-grid cards use compact Yes/No rows; featured/detail views retain Visx charts from actual available history. Keep responsive layouts, readable status text, keyboard interaction and reduced-motion support. The Dragon art represents a selection from the wider collection.

Council and NFT membership share `/council`, with section links for collection, joining information and cases. The old `/membership` URL leads to `/council#membership`.

### Shared page design

`components/PageHeader.tsx` provides a screen-reader-only `PageLandmark` for main routes and visible headings for recovery screens. Main pages have no repeated visible title or subtitle and start directly with content. The shared header places How it works immediately before the theme toggle; it opens a native modal with the introductory guide. Sora is reserved for the Dragons Market wordmark; IBM Plex Sans is used for page content. Page title size, section title size and vertical rhythm are shared variables in `app/studio.css`. Use these before adding route-specific heading styles. Do not add an eyebrow that repeats the page title, a second Council menu, or captions to the large partner hero image. The NFT collection and official partner logos provide the imagery; contract actions remain disabled until integration is ready.

The guide component lives in `components/HowItWorksDialog.tsx`, with content in `components/HowItWorks.tsx`. Keep the guide out of the main market page. The modal shows one of three steps at a time, with Back, Next and Finish controls, and resets to the first step when reopened. It manages focus, Escape, backdrop dismissal and body scroll locking, and respects reduced motion. Page recovery and account empty states keep their useful explanations.

Main route containers share `.page-content` top spacing. Keep market questions and meaningful section headings visible. Do not restore a page-title banner that repeats the selected navigation item.

Header guide interaction: hovering or focusing How it works shows a rectangular surface highlight. Extra space separates it from the theme toggle. The guide has a wider layout, an explicit step counter and progress marks. Step changes focus the new step heading; Finish closes the guide and returns focus to the trigger.
