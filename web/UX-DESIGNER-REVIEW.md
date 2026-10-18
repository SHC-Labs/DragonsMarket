# UX Designer review: The Council

Date: 2026-10-18. Skill: https://github.com/szilu/ux-designer-skill, installed at `/home/nameless/.agents/skills/ux-designer/`. Applied its review workflow and accessibility, mobile and writing references.

## Context and scope

Audience: people discovering prediction markets, choosing Yes/No, following positions, and learning about NFT membership and dispute resolution. Primary task: find a market, understand its rules and odds, obtain a quote, and trade. Constraints: existing Minimal Studio layout, Iconsax, purple markets, Forest Membership, Sage Council, both themes, no invented live economics.

This is an assessment, not a redesign or implementation pass. Application files were not changed. The local sandbox was reseeded for 8 hours and the preview restarted against the new contracts. No transactions were signed or sent. Read-only account states used the existing sandbox account preview.

## Findings in priority order

### [Blocker] Buy quote response no longer matches frontend assumptions

Where: `components/TradeTicket.tsx:59`, `lib/market.ts:72`, `contracts/pm-market/src/lib.rs:750`.

Observed: opening market 0 as the seeded Alice account, with 3,038 mUSD balance, and entering 10 produces blank share/price estimates and “This trade is not possible right now.” The contract returns `{shares_out, fee}`. The frontend declares a string result and tries `BigInt(response)`, catches the error, and treats the trade as impossible.

Fix: align the frontend quote type and decoding with the current contract, use the returned fee and shares, and add a contract-shaped response regression test. Validate both buy and sell paths and slippage arguments before enabling real signing. Ref: visibility of system status, error prevention, skill forms/error-state guidance.

### [Blocker] Disputed market crashes instead of showing its jury

Where: `components/Resolution.tsx:163`, `lib/market.ts:51`, `app/council/view.tsx:12`; `contracts/pm-oracle/src/lib.rs:566`.

Observed: `/market?id=2` raises “Cannot read properties of undefined (reading length)” at `cfg.panel.length`. Current oracle configuration has `jury_size` and `council`, not a global `panel`. The actual drawn panel belongs to each case. Council's overview silently shows an empty roster for the same stale assumption.

Fix: model current oracle and case response types, render the case's panel, and handle undrawn juries explicitly. Check proposed, disputed, finalized and failed/partial loading states. Do not substitute an empty array and pretend the dispute model is fixed. Ref: error prevention and recovery; accurate status.

### [Major] Fee display is hardcoded to zero

Where: `components/TradeTicket.tsx:186` and contract buy/sell quote responses.

Observed in source and rendered ticket: “Fee 0.00 mUSD” is unconditional even though current quote responses contain a fee field. A zero fee can misrepresent trade cost.

Fix: display the actual quoted fee, show a pending/unavailable value before a valid quote, and reconcile estimated and final amounts. Ref: informed decisions, accurate financial microcopy.

### [Major] Enlarged text pushes Membership content off-screen

Where: `.initiation-copy`, `.membership-overview`, `.ritual-button` in `app/studio.css`.

Observed: at 320 CSS px width with root text enlarged to 200%, Membership content extends to about 476 px and its primary CTA to 417 px. Default-size pages do not have this overflow. This is a text-resizing stress test, not a complete browser-zoom certification.

Fix: use `minmax(0,1fr)`/`min-width:0` for grid children, permit CTA labels and headings to wrap, and stack overview label/value pairs at constrained sizes. Recheck 200% text and browser zoom. Ref: WCAG 1.4.4 Resize Text and 1.4.10 Reflow verification.

### [Minor] Mobile navigation hides later destinations without a scrolling cue

Where: `components/Header.tsx:48`, `.mobile-site-nav`.

Observed: at 320 px the six-link nav has a 414 px scroll width. Keyboard focus scrolls the last item into view, but a touch user sees a clipped later label with no clear cue that more navigation is available.

Fix: retain scrolling but add an edge cue, ensure the active destination scrolls into view, or use a compact explicit navigation menu. Preserve Partnerships before Portfolio. Ref: discoverability and mobile navigation guidance.

### [Minor] Buy/Sell advertises tab semantics without arrow-key behavior

Where: `components/TradeTicket.tsx:124`.

Observed: ArrowRight from focused Buy leaves Buy selected. Both buttons can still be reached and activated using Tab and Enter, so this is not a total keyboard block.

Fix: implement roving tab focus with ArrowLeft/Right and Home/End, associated panels, or use native buttons with pressed states for the two modes. Ref: expected keyboard behavior for the chosen widget semantics.

### [Minor] Repeated navigation has no direct skip-to-content control

Where: `app/layout.tsx`, `components/Header.tsx`.

Observed: the first Tab stop is the brand link, followed by header controls/navigation. Main landmarks exist, but sighted keyboard users cannot skip repeated header controls with a single link.

Fix: add a focus-visible “Skip to content” link and a main target. Verify focus is not obscured by sticky chrome. Ref: WCAG 2.4.1 Bypass Blocks and 2.4.11 Focus Not Obscured verification.

### [Preference tradeoff] Requested animation overrides reduced-motion defaults

Where: `components/FeaturedCarousel.tsx:12`, `components/CollectionGallery.tsx`, collection hover styles.

The user previously explicitly requested autoplay and noticeable NFT tilt. The existing 620 ms slide animation and image tilt persist under reduced motion; the carousel has a working Pause control and pauses on keyboard entry. This review does not reverse those accepted choices.

Recommendation: retain normal-mode behavior and consider an instant or fade transition plus stationary artwork under reduced motion. This is an optional preference change, not an applied fix or a claim of a specific AA failure.

## Evidence and checks

- Six top-level routes reviewed: Markets, Watchlist, Council, Membership, Partnerships, Portfolio. Both themes.
- Rendered axe scans with WCAG 2 A/AA, 2.1 AA and 2.2 AA tags: no automated violations on the informational/disconnected-account pages or normally rendered tested market pages. This does not certify accessibility.
- Disputed-market axe results concern Next's crash document (missing title/lang), not two independent application accessibility defects. The actual finding is the crash above.
- Loaded markets: 21 seeded records. Pagination advances batches (9 to 18 at the tested default viewport); search returns an understandable zero-results state; clearing search restores results; outcome links select the requested side.
- A market saved to the account-scoped watchlist appeared on `/watchlist`. Connected read-only Portfolio displayed 20 positions and 2 resolved markets. Cross-device sync and real-wallet signing were not tested.
- Default-size layouts at 320, 720 and 1024 px had no document-level horizontal overflow. Loaded market detail at 320 px also had none.
- Keyboard focus visible; focused mobile nav item scrolls into view. Buy/Sell arrow behavior noted above.
- Existing mint status fix remains in place. Both green palette pages passed prior surface/text contrast checks; no new contrast finding was raised by axe in this pass.
- Offline states were observed before reseeding. Loading, empty-search, disconnected-wallet, proposed/disputed/final states were reviewed. No exhaustive slow-network, huge-data, localization/RTL, real browser zoom, screen-reader or transaction testing was done.
- Screenshots: `/tmp/ux-membership-dark.png`, `/tmp/ux-membership-light.png`, `/tmp/ux-council-dark.png`, `/tmp/ux-partnerships-dark.png`, `/tmp/ux-membership-320.png`, `/tmp/ux-detail-phone.png`. Raw scan output: `/tmp/ux-audit-initial.json`, `/tmp/ux-audit-live.json`.

## Recommended next pass

First synchronize quote and dispute DTOs with the current contracts and remove the unconditional zero-fee claim. Then fix text resizing, mobile navigation discoverability and keyboard tab behavior. Keep the current page-specific palettes and overall layout; the evidence does not justify another visual redesign.

## Follow-up implemented, 2026-10-18

User clarified that contracts are still in development and asked to leave integration points only. Accordingly, no contract code, ABI or economic rules were implemented or changed.

- TradeTicket is now local UI state only. Buy/Sell uses native pressed buttons, outcome selection and input remain interactive, and invalid amounts have inline errors. Quotes/fees show unavailable and the disabled “Trading coming soon” action has a visible explanation. It makes no quote or transaction calls. Existing contract adapters remain in `lib/market.ts` for later integration; their interfaces still require final review.
- Resolution is read-only, with existing case reads, loading/error/retry states, public evidence and votes where available. It no longer assumes a global jury array or renders proposal, challenge, voting or settlement actions. It does not claim the final jury integration is ready.
- Council no longer fetches a global oracle panel. Its roster connection remains pending instead of reading a nonexistent config field.
- Membership grid children and CTA labels can shrink/wrap. At 320 and 1440 CSS px, both themes fit with 200% root text sizing and no document overflow.
- Mobile navigation has a visible swipe hint and scrollbar, and centers the active route on navigation. Partnerships remains before Portfolio.
- Added focus-visible Skip to content targeting the main landmark. Keyboard activation was verified.
- Existing requested autoplay/tilt behavior and page palettes were preserved.

Verification: TypeScript, ESLint and 24 existing tests pass. Browser checks confirmed disputed-market rendering without runtime errors, keyboard mode selection, input validation, unavailable fee, disabled submission, skip-link focus and text-resizing behavior. No real-wallet signing or contract transaction was attempted. New contract integration is intentionally pending, not certified working by this follow-up.
