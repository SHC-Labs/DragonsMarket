# Website response to review sections 9 and 10

Architecture follow-up, 2026-10-19: [intents-architecture.md](../intents-architecture.md) now records the owner decision that platform fungible tokens, backing, bonds and rewards remain in Intents. The dispositions below describe the earlier website review against existing NEP-141 contracts. Final funding, trading, voting/bond, reward and withdrawal wiring must use the new reviewed settlement/identity model; financial writes remain pending. No contract or runtime behavior is changed by this follow-up.

Date: 2026-10-19. Scope: `web/` only. Source: `/home/nameless/Downloads/contract-and-website-review-2026-10-19.md`, sections 9 and 10. Contract findings, contracts, deployment and economics are outside this change and remain with Claude. Existing work elsewhere, including spec edits, was not modified.

## Section 9

| Item | Website disposition |
| --- | --- |
| W-01 Void payout | Added optional published `void_price_yes`; read-only estimate uses BigInt `(yes*p + no*(1e6-p))/1e6`. Missing/invalid price stays unknown. Removed half-token FAQ claim. Tested asymmetric holdings, endpoints, invalid values and rounding. |
| W-02 Voting | Removed nonexistent `panel_vote` builder. Voting remains unwired. Commit/reveal, salt persistence/recovery, phase validation and draw actions require a separate integration against the final contract. No salt or signature logic was improvised. |
| W-03 Shapes | Case now documents optional case-level jury/commit/timing fields; config no longer declares global `panel`. Existing screens remain read-only and do not assume that a global panel exists. These are provisional DTOs, not a generated or certified final ABI. |
| W-04 Quotes | Read adapters declare `{shares_out,fee}` and `{collateral_out,shares_in,fee}`. Added and tested net sell display helper. Ticket remains local-only and displays no invented estimates/fee. |
| W-05 Pagination | List reads continue in 50-record pages to the short page, detecting repeated records rather than looping indefinitely. Used by both browse and portfolio. Unit coverage for 103 records and exact page boundaries; browser fixture has 53. |
| W-06 Seeding | Browse and detail exclude explicit `seeded:false` and unregistered records. Unknown seeding state is retained for compatibility with existing read data, so complete enforcement still depends on the final contract exposing the field. Browser check covers explicit false. |
| W-07 Storage | Pending final integration. No first-buy flow is enabled, so no storage registration is silently skipped by an executable buy button. |
| W-08 Errors | “Has not closed” now means still open, separately from closed/resolved. Added position-limit and dust errors. Unknown errors no longer promise that nothing was taken. |
| W-09 Dust | Positive slippage minimum clamps to 1; a nonexistent/zero input stays zero. Regression test added. |
| W-10 Token registration | Pending final token selection/storage ABI. Portfolio withdrawal stays disabled with an explanation; no mainnet token-registration assumptions. |
| W-11 Withdrawal completion | Removed active portfolio mutation flow and its unsafe balance-zero success claim. Final receipt verification must be implemented when withdrawal is enabled. No transaction success is fabricated. |
| W-12 Gas | Deferred with transaction integration. Existing unused call builders remain placeholders; future method budgets must be rechecked against final contracts, including reveal/finalize/draw/unstake/execute. No contract gas floors were changed. |
| W-13 History delta | Detail now says “over the available history”, not since opening. No opening price is inferred from a rolling log. |
| W-14 E2E | Replaced stale dev-chain assertions with current read-only behavior. Added focused chain-independent website tests for pagination, history fan-out, shared themes, pending ticket/portfolio writes and unseeded detail. Live signing tests remain out of scope. |
| W-15 RPC | Browse now fetches histories only for the five selected featured markets; shared recent/in-flight reads are deduplicated. Refresh reduced from 8 to 30 seconds. Failed history reads do not hide market cards. Recent-price block explicitly describes featured markets. Full market lists and closed-case reads still scale with data; an indexer/batched backend remains future work. |
| W-16 Wallet batching | Pending final transaction flow. No function-call key is requested. No batching API or wallet permissions changed. |

Evidence links now show the external hostname and tolerate malformed URLs without a render-time exception.

## Section 10

- Shared purple venue background, surfaces, borders, header, footer, wallet controls and navigation on all routes. Removed route-wide root green overrides.
- Council and Membership now share mint/forest semantic accents within their wrappers; sage is consolidated as recommended. Existing layout and dragon artwork are retained.
- `--brand` handles generic venue links/navigation; `--council` consistently identifies dispute/Council information. Challenged badges and the resolution record use Council green.
- One outcome pair is used by cards, trade display, detail bars and Visx charts through aliases. Dark Yes/No: `#e7c2f7` / `#2fa39a`. Light: `#5c0f6b` / `#14756f`. The proposed light teal was slightly darkened because `#167f79` measured 4.19:1 on the raised surface. Text labels and dashed No chart line remain.
- Errors use danger tokens, not the No outcome color. Primary dark fill is `#9f50a4`, with readable white text.
- Category tiles have quieter theme-specific background/ink pairs. Sigils reference semantic tokens instead of fixed ledger colors. Hover fills and browser theme chrome follow the selected palette.
- `design/palette.json` is the canonical shipped color source; `npm run tokens` generates `app/palette.css` and checks text, category and button contrast in both themes. Removed old root color generations from globals/studio and old color entries in tokens.css; retained legacy shared layout rules still in use and replaced their literal palette values. A wholesale deletion of old layout selectors was deliberately avoided to prevent unrelated regressions.
- `replica/design/` is an older reference and is no longer copied over the shipped palette by the token command. Nothing outside web was regenerated or overwritten. Future design documentation should point to web/design/palette.json.
- Instrument Serif now has a deliberate role in Council headings and the resolution verdict. Body and trading UI remain sans-serif.

## Validation and limits

- TypeScript, ESLint, and 32 unit tests pass.
- Canonical palette generation/contrast checks pass for dark and light text, raised surfaces, category tiles and primary/Council button labels.
- All 10 focused Playwright checks pass. The suite uses deterministic mocked view responses, not fabricated product data: desktop 1440 and phone 320. It exercises current UI without requiring contract signing or changing contracts.
- The updated dev-chain suite is read-only. It was not presented as a successful real-wallet, final-ABI or on-chain transaction test.
- Informational pages visually reviewed in both themes. Screenshots: `/tmp/review-membership-dark.png`, `/tmp/review-council-light.png` and companion themes.
- Contract files and spec were untouched. Contract-dependent items above remain explicit integration work, not silently marked fixed.


## Council page consolidation, 2026-10-19

Follow-up to section 10.2.3: Council membership and dispute participation are one identity. The earlier pass unified the accents but left two pages; the owner requested the page merger explicitly.

- `/council` now contains the membership/launch information, four-piece collection gallery with its tilt interaction, staked-seat responsibilities, fee-revenue allocation, live case records, dispute process and one combined FAQ.
- Header and footer have one Council entry. In-page section links reach membership, collection, cases, process and questions.
- `/membership` is a compatibility route that replaces the URL with `/council#membership`, including in the static export. A usable link remains before hydration or without JavaScript.
- Removed the empty permanent-panel roster and stale undecided holder-vs-AI copy. Jurors are drawn per case from eligible staked seats; only eligible staked seats earn. Quarterly payouts remain planned, not a claim that the final claim integration is live.
- Contract-dependent writes remain unwired. This change does not implement minting, staking, voting, Intents custody or reward claims.

Validation for this consolidation: TypeScript and focused ESLint pass; the local-chain static export builds successfully; all four navigation/legacy-route Playwright checks pass on phone and laptop. The running dev site was checked at 320, 390 and 1440 px in both themes with four artworks, four live case rows, no page overflow or JavaScript errors, working section links and keyboard-operated FAQ disclosure. Axe found no violations within main content in either desktop theme. These checks do not certify financial transaction integration.

## Second pass against the outside review's sections 9 and 10, 2026-10-19

The owner requested another item-by-item check after the Council/Membership page consolidation. This table supersedes any implication that all contract wiring was finished by the original visual pass. Implementation findings in sections 1-8 remain outside this frontend task.

### Omissions corrected in this pass

- Section 10.3.7: the category containers were themed, but the hand-drawn basketball, baseball, football and soccer artwork still had fixed SVG colours. Those fills/strokes now use the same theme-aware sports tokens as their containers.
- Section 10.3.3: featured-carousel selection, Show More hover, the generic watchlist browse link, chart marker decoration and a portfolio balance accent still used Council green. They now use venue brand semantics. Actual Council/dispute links and challenged/result records keep Council green.
- Section 10.3.9: the serif rule previously styled Council headings and the Public votes subheading, but not the final-answer paragraph itself. The actual final verdict now has explicit Instrument Serif styling and the Council colour.
- Section 10.2.5 and 10.3.8: the product spec still prescribed the old violet/cult/Zcash-art direction. It now names the unified Council page, current Dragon artwork, mint/forest accent and canonical shipped palette. Earlier design-review files are labeled historical and point to the current palette/response instead of presenting sage/separate-page directions as current.

The Council/Membership page merger was completed in the preceding consolidation task. It remains at `/council`, with `/membership` retained only as a compatibility route.

### Section 9: all wiring items accounted for

| Item | Current disposition | Remaining dependency |
| --- | --- | --- |
| W-01 Void display | BigInt weighted-price estimate and explanatory copy fixed; an unknown price stays unknown. | Verify the final published settlement fields/rounding against the new settlement interface. |
| W-02 Vote action | Removed nonexistent `panel_vote`; no financial voting action is enabled. | Commit/reveal, secret persistence/recovery, draw/finalize actions and final ABI integration. |
| W-03 DTOs | Removed global-panel assumption and added provisional case fields used by read-only UI. | Generated/verified types for the final contracts, including latest case-round/timing fields and Intents identity. This is partial, not a completed ABI regeneration. |
| W-04 Quotes | Corrected quote DTO shapes and tested gross-minus-fee display helper. | Runtime buy/sell quote/confirmation integration remains off. |
| W-05 Pagination | All-market reads continue through 50-record pages and reject repeated pages. | No missing implementation identified for the current view API; keep pagination when the provider changes. |
| W-06 Unseeded markets | Explicit `seeded:false` and unregistered records are excluded on browse/detail. | Unknown seeding state remains a compatibility allowance until final view fields are settled. |
| W-07 User storage | Trade controls are disabled; no executable first trade skips registration. | Final account/storage requirements, registration and batching. |
| W-08 Error messages | Still-open, closed, resolved, position-limit and dust messages are distinct. Unknown results require checking final status. | Recheck new contract/provider failures when wiring starts. |
| W-09 Dust | A positive slippage floor cannot become zero. | Retest with final token decimals and quote ABI. |
| W-10 Token storage | Withdrawal controls remain disabled. | Selected token/provider registration requirements; do not blindly apply a legacy NEP-141 wallet flow to Intents custody. |
| W-11 Withdrawal success | Removed balance-zero success logic and active portfolio sends. | Verify complete receipt chains and final destination confirmation before reporting success. |
| W-12 Gas | No gas-sensitive financial controls are enabled. | Existing unused call builders are scaffolding, not reviewed final gas/deposit settings. Replace/revalidate them against final methods and measurements. |
| W-13 History delta | Detail states that the move covers available history. | Opening-price storage is not implemented and is no longer implied by this label. |
| W-14 E2E | Current read-only behavior, page merge, legacy links and review regressions have focused browser coverage. | Real wallet signing/transaction/recovery coverage waits for enabled integration. |
| W-15 RPC load | Home history reads limited to five featured markets with 30-second caching/polling; Council polling is also 30 seconds. | A batched view/indexer is not built; full market/closed-case reads still grow with data. This recommendation is only partially implemented. |
| W-16 Wallet prompts | No function-call key is requested and no new financial send flow is enabled. | Final authorized wallet batching/signing experience. |

### Section 10.3: all nine recommendations accounted for

| Recommendation | Current evidence |
| --- | --- |
| 1. Shared chassis | Venue surfaces, header/footer and wallet controls stay on the shared palette; Council changes scoped accent tokens only. |
| 2. One Council accent | Mint/forest tokens are shared by membership and cases, now on the same page; sage is retired as a current route palette. |
| 3. Separate brand/Council roles | Generic venue controls use brand; disputes, Council information and final verdicts use Council. Remaining active generic-control leaks found in this pass were corrected. |
| 4. Consistent outcome pair | Generated chart colours alias Yes/No tokens. Words, labels and the dashed No line remain; the light teal is darkened for text contrast. |
| 5. Error semantics | Ticket validation, notices and portfolio errors use danger tokens, not the No outcome token. |
| 6. Visible primary fill | Dark primary fill is `#9f50a4`, with readable white text. |
| 7. Theme-aware colours | Sigil and all category/sports artwork use semantic tokens; hover and browser chrome follow the selected theme. Partner/NFT artwork retains its source colours. |
| 8. Canonical tokens | `web/design/palette.json` generates `app/palette.css` with contrast checks. Old root palette generations are removed; older layout selectors remain where needed. Historical design documents now point to the shipped source. |
| 9. Deliberate serif | Council headings and the actual final verdict use Instrument Serif. General trading/body UI remains sans-serif. |

Financial actions, Intents settlement, new custody authorization and real-wallet transaction tests remain pending. This second pass does not claim them complete or change any contract implementation.


Second-pass verification: canonical token generation/contrast checks passed; TypeScript and focused ESLint passed; all 32 unit tests passed; all 16 website-review/navigation browser checks passed at 320 px and 1440 px against the dev server. These browser checks use mocked RPC data to verify 53-market pagination, history request limits, unavailable financial writes, unseeded filtering, both themes, merged routes, sports token colours and actual verdict typography. Separate real-chain checks loaded market cards and the final No verdict for market 3 in both themes; screenshots were visually inspected. No financial action or contract implementation was exercised or changed by this task.

## Owner design update, 2026-10-19

The latest owner instruction supersedes review recommendations 10.3.1 (purple chassis on Council) and 10.3.9 (Council serif typography). Council now uses a complete mint/forest theme, including canvas, cards, controls, navigation, footer and browser chrome. Other routes retain the purple venue theme. All headings and verdicts share IBM Plex Sans with the rest of the website. JetBrains Mono remains available for numeric details.

The generated palette remains the single colour source. Its generator checks both venue and Council contrast in both light and dark modes. Route changes, direct Council loads, the legacy membership link and theme changes all select the correct complete palette. The approved Dragons Market crest replaces the temporary D lettermark in the shared header and footer, with the same crest used as the browser icon. The Council page heading is now Dragon Council. Contract integrations remain placeholders.

## Owner whole-site simplification, 2026-10-19

The owner requested consistency across pages and fewer decorative labels. Page titles now share one component, font size, weight, position and description style. The Sora wordmark and larger dragon crest remain the shared brand. Council's secondary menu, introductory NFT eyebrow, repeated section eyebrows and gallery numbering have been removed. Membership remains on Council, with terms, mint status, collection selection, public cases, process and questions preserved.

Partnerships now follows the same title scale as other routes. Its hero keeps the approved two-logo pairing and original artwork, removes the oversized slogan and visible image caption, and uses one factual paragraph. Game cards retain useful descriptions. Watchlist and Portfolio share one account empty state, and market detail, rules and missing-page states follow the same hierarchy. Existing contract placeholders and integration boundaries are unchanged. See DESIGN-REVIEW.md for the current design rules and validation scope.
