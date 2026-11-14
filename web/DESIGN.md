---
version: alpha
name: Dragons Market
description: "Prediction markets on NEAR. Orchid and mint on purple-black; Funnel Display and IBM Plex. Generated from design/tokens.json by npm run tokens."
colors:
  primary: "#d4a2db"
  secondary: "#a8dfc0"
  bg: "#0b080e"
  surface: "#171119"
  raised: "#210f26"
  border: "#44384b"
  border-input: "#9987a3"
  text: "#f0edf2"
  text-muted: "#bfb5c5"
  brand: "#d4a2db"
  brand-soft: "#2f0e35"
  accent: "#9f50a4"
  on-accent: "#ffffff"
  accent-hover: "#8b4093"
  focus: "#d4a2db"
  council: "#d4a2db"
  council-soft: "#2f0e35"
  on-council: "#1a0b1e"
  yes: "#e7c2f7"
  yes-soft: "#290036"
  no: "#2fa39a"
  no-soft: "#102c2a"
  success: "#9ed6b4"
  danger: "#f4a4b0"
  danger-soft: "#351923"
  warning: "#e3c47e"
  warning-soft: "#302716"
  info: "#c8bdcf"
  info-soft: "#210f26"
  category-politics-bg: "#253b55"
  category-politics-ink: "#bbd3ed"
  category-sports-bg: "#483125"
  category-sports-ink: "#edc4a1"
  category-crypto-bg: "#44381f"
  category-crypto-ink: "#e8cd8e"
  category-economy-bg: "#203d35"
  category-economy-ink: "#a9dac8"
  category-tech-bg: "#38304f"
  category-tech-ink: "#d4c2ef"
  category-culture-bg: "#492f40"
  category-culture-ink: "#e5bbd3"
  category-world-bg: "#243b41"
  category-world-ink: "#a9d1d9"
  category-other-bg: "#35323c"
  category-other-ink: "#c7c3d0"
  crest: "#a8dfc0"
  bg-light: "#fbfafc"
  surface-light: "#ffffff"
  raised-light: "#f2edf4"
  border-light: "#ded3e2"
  border-input-light: "#927d9c"
  text-light: "#0b000f"
  text-muted-light: "#64556c"
  brand-light: "#6e0183"
  brand-soft-light: "#f0e5f3"
  accent-light: "#6e0183"
  on-accent-light: "#ffffff"
  accent-hover-light: "#570068"
  focus-light: "#6e0183"
  council-light: "#6e0183"
  council-soft-light: "#f0e5f3"
  on-council-light: "#ffffff"
  yes-light: "#5c0f6b"
  yes-soft-light: "#f0e5f3"
  no-light: "#14756f"
  no-soft-light: "#e4f2ef"
  success-light: "#21643e"
  danger-light: "#a12343"
  danger-soft-light: "#fce9ef"
  warning-light: "#75520a"
  warning-soft-light: "#fcf3d9"
  info-light: "#64556c"
  info-soft-light: "#f2edf4"
  category-politics-bg-light: "#e7eef6"
  category-politics-ink-light: "#294867"
  category-sports-bg-light: "#f5ebe3"
  category-sports-ink-light: "#80502e"
  category-crypto-bg-light: "#f3eddf"
  category-crypto-ink-light: "#765b24"
  category-economy-bg-light: "#e4f0ea"
  category-economy-ink-light: "#2d6752"
  category-tech-bg-light: "#ede8f6"
  category-tech-ink-light: "#654486"
  category-culture-bg-light: "#f4e7ef"
  category-culture-ink-light: "#85466e"
  category-world-bg-light: "#e6f0f2"
  category-world-ink-light: "#356875"
  category-other-bg-light: "#eceaef"
  category-other-ink-light: "#60566d"
  crest-light: "#23734d"
typography:
  odds-hero:
    fontFamily: "Funnel Display"
    fontSize: 8.5rem
    fontWeight: 500
    lineHeight: 0.78
    letterSpacing: -0.04em
  market-title:
    fontFamily: "Funnel Display"
    fontSize: 3.5rem
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: -0.02em
  page-title:
    fontFamily: "Funnel Display"
    fontSize: 3rem
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.025em
  card-title:
    fontFamily: "Funnel Display"
    fontSize: 1.25rem
    fontWeight: 600
    lineHeight: 1.18
    letterSpacing: -0.025em
  price:
    fontFamily: "Funnel Display"
    fontSize: 1.75rem
    fontWeight: 500
    lineHeight: 1
    letterSpacing: -0.04em
  heading:
    fontFamily: "IBM Plex Sans"
    fontSize: 1.375rem
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: -0.02em
  body:
    fontFamily: "IBM Plex Sans"
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
  ui:
    fontFamily: "IBM Plex Sans"
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "IBM Plex Sans"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.3
  identifier:
    fontFamily: "IBM Plex Mono"
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: -0.01em
rounded:
  xs: 6px
  sm: 10px
  md: 14px
  lg: 20px
  pill: 999px
spacing:
  "1": 0.25rem
  "2": 0.5rem
  "3": 0.75rem
  "4": 1rem
  "5": 1.25rem
  "6": 1.5rem
  "7": 2rem
  "8": 2.5rem
  "9": 3rem
  "10": 4rem
  "11": 5rem
  "12": 6rem
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: "44px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: "44px"
    padding: "0 20px"
  outcome-yes:
    backgroundColor: "{colors.yes-soft}"
    textColor: "{colors.yes}"
    typography: "{typography.price}"
    rounded: "{rounded.md}"
  outcome-no:
    backgroundColor: "{colors.no-soft}"
    textColor: "{colors.no}"
    typography: "{typography.price}"
    rounded: "{rounded.md}"
  status-pill:
    textColor: "{colors.success}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 10px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "24px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "52px"
---

# Dragons Market design

Agent-facing summary of the brand for building UI in `web/`. The front matter above is generated
from `design/tokens.json` by `npm run tokens`; edit the JSON, never the front matter. See every token and component live at `/brand`.

## Overview

A prediction market on NEAR with its rules on the front. Visual idea: **Sealed by Dragons**. Each
market is a sealed contract; the Dragon Council guards how it ends. Dark first, purple-black ground,
two brand colours: **orchid** (Yes, brand ink, focus) and **mint** (No, the crest). Quiet, precise
surfaces with one ceremonial moment per page: a seal, the crest, the big chance-of-Yes number, the
Dragon reel. Confident at the door, precise at the money.

## Colors

Use roles through CSS variables or the Tailwind utilities in `app/theme.css`. Never a hex value.

| Need                     | Use                                                                      |
| ------------------------ | ------------------------------------------------------------------------ |
| Page, card, inset        | `--bg`, `--surface`, `--raised` (`bg-canvas`, `bg-surface`, `bg-raised`) |
| Text                     | `--text`, `--text-muted` (`text-fg`, `text-muted`)                       |
| Lines                    | `--line` (hairline), `--border`, `--border-input` (controls)             |
| Links, active nav, focus | `--brand`, `--focus`                                                     |
| The one primary button   | `--accent` fill, `--on-accent` text (`.btn-primary`)                     |
| Yes side                 | `--yes`, `--yes-soft`, `--yes-tint`                                      |
| No side                  | `--no`, `--no-soft`, `--no-tint`                                         |
| Status, price movement   | `--success`, `--danger`, `--warning`, `--info` and their `-soft` fills   |
| Council and disputes     | `--council`, `--council-soft`                                            |
| Category chip or emblem  | `--category-<name>-bg`, `--category-<name>-ink`                          |
| The crest                | `--crest` (mint)                                                         |

Mix with `color-mix(in oklab, var(--role) N%, transparent)`. Derived roles already exist in
`app/tokens.css` (`--glass`, `--glow-brand`, `--elev-1` to `--elev-3`, `--accent-fill`); reuse them.

## Typography

Two families. `--font-display-stack` (Funnel Display) for market questions, page titles, odds,
prices, balances and verdicts. `--font-sans-stack` (IBM Plex Sans) for everything else.
`--font-mono-stack` (IBM Plex Mono) only for rule hashes, account IDs and keyboard keys.

- Sizes run from `--fs-2xs` (12px) to `--fs-6xl` (88px). Named styles are in the front matter.
- Numbers: class `num` (Plex tabular) in running text; the display classes in
  `styles/showreel.css` for hero numbers. Prices always use tabular lining figures.
- Sentence case everywhere. Eyebrows (`.eyebrow`, uppercase tracked) name a page section, at most
  one per section.
- Copy: active verbs, a unit on every amount (71¢, 71%, +6 pts, 200.00 mUSD), dates as
  "30 Jan, 21:08", no em dashes, no exclamation marks. Never "bet", "gamble", "guaranteed".

## Layout

- 4px grid: `--s-1` (4px) to `--s-12` (96px). No other spacing values.
- Page width `--page-max`, side padding `--gutter`, section spacing `--section-space`.
- Breakpoints in use: 767px (phone) and 1023px (tablet). Check 390px and 1440px.
- Market pages: question and price panel left, trade ticket (`--ticket-w`) right; stacked on phones.

## Elevation & Depth

`--elev-1` for controls and chips, `--elev-2` for cards on hover and menus, `--elev-3` for dialogs
and hero art. Dark mode lifts with an inset highlight and a deep shadow; light mode with a faint
orchid shadow. `--glass` and `--glass-strong` for sticky bars over content. No other shadows.

## Shapes

Radius follows hierarchy: `--r-xs` keys and focus rings, `--r-sm` buttons, `--r-md` inputs and
outcome buttons, `--r-lg` cards and panels, `--r-pill` status pills, tabs and chips. Controls are
`--control-sm` (36px), `--control-md` (44px) and `--control-lg` (52px). Touch targets are at least
44px.

## Components

Reuse before building. Import from these files and extend them rather than copying markup.

| Component | File | Use when | Not when |
| --- | --- | --- | --- |
| `Button` | `components/ui.tsx` | An action. `primary` once per view, `secondary` otherwise, `ghost` for low stakes, `danger` for destructive | Navigation: use `LinkButton` or `PageLink` |
| `LinkButton`, `PageLink` | `components/ui.tsx` | Navigation styled as a button or an inline link | Actions |
| `StateBadge` | `components/ui.tsx` | A market's state: Open, Paused, Final, Closed, Answer proposed, Challenged | Arbitrary tags |
| `Notice` | `components/ui.tsx` | Inline info, warning or error with the right live role | Toasts or promotional banners |
| `Price` | `components/ui.tsx` | A price in cents coloured by side | Percentages or balances |
| `SplitMeter`, `ProbBar` | `ui.tsx`, `MarketCard.tsx` | The Yes and No split as one bar; labels carry the numbers | Single values |
| `DeltaChip` | `components/Featured.tsx` | A change in points with an arrow and status colour | Outcomes |
| `StatTile`, `Eyebrow`, `SectionTitle` | `components/ui.tsx` | Summary figures, section names, section headings | Page titles |
| `PageLandmark`, `PageHeader` | `components/PageHeader.tsx` | Each route's single h1 | Other headings |
| `MarketCard`, `MarketGrid` | `components/` | Lists of markets | A single market page |
| `FeaturedMarket`, `Trending` | `components/Featured.tsx` | The home page spotlight | Elsewhere |
| `MarketOutcomeChart` | `components/` | Probability over time: Yes orchid solid, No mint dashed | Volume or candles |
| `TradeTicket` | `components/` | Buying and selling on a market page | Anywhere else |
| `RulesBlock`, `Resolution` | `components/` | The rule, result source and case record | Summaries |
| `MarketSeal`, `Sigil` | `components/` | The ceremonial seal struck from a rule hash | General decoration |
| `MarketIcon`, `CategoryEmblem` | `components/` | A market's category glyph in its category colours | Generic icons |
| `Brand` | `components/Brand.tsx` | The crest and wordmark lockup | Rebuilding the logo |
| `TradeFeed` | `components/TradeFeed.tsx` | The latest buys and sells from the backend's event index, all markets or one; hidden without a backend | Price history: use the chart or `RecentPrices` |
| `CountUp` | `components/CountUp.tsx` | Numbers that change while the user watches | Static numbers |
| Icons | `components/icons.tsx` | Every icon. Phosphor; `Linear` by default, `Bulk` or `TwoTone` decorative, `Bold` selected; 16, 20 or 24px | Importing `@phosphor-icons/react` directly |
| Dialogs | `HowItWorksDialog.tsx`, `TermsAcceptanceDialog.tsx` | Native `<dialog>` with `--elev-3` | Custom overlay divs |
| `ModalDialog` | `components/ModalDialog.tsx` | The shared native modal for wallet steps: takes focus, keeps Tab inside, closes on Escape, returns focus, locks page scroll | Information a person can read without acting: use a page section |
| `ConnectDialog` | `components/ConnectDialog.tsx` | Choosing a NEAR, Ethereum-compatible or Solana wallet; on a phone with no wallet, "Open in" links to wallet browsers | Any other choice. Shown only when the relay is configured; otherwise NEAR connects directly |
| `DepositDialog` | `components/DepositDialog.tsx` | Getting a 1Click deposit address for USDC on Base, Arbitrum or Solana into an EVM or Solana account's Intents balance, then its status | NEAR accounts, which fund from their wallet in the trade ticket |
| `AnswerPanel`, `AnswerForm` | `components/AnswerPanel.tsx` | Proposing or challenging a result with an EVM or Solana wallet, inside `Resolution`. `AnswerForm` is the form without wallet or network | NEAR accounts, and voting: both say a NEAR wallet is needed |

Styles live in `app/styles/<area>.css` with semantic class names. Put a new component's styles in
its area's file. Use Tailwind utilities only for one-off layout.

## Do's and Don'ts

- Do show the word Yes or No next to every orchid or mint outcome colour.
- Do give every price its unit and tabular figures.
- Do keep the rule and result source one step from any price.
- Do design every state: loading, empty, error, disabled, closed, final, coming soon.
- Do check 390px and 1440px in both themes before calling UI done.
- Don't use a hex, rgb or oklch value outside `design/tokens.json`. `npm run check:brand` fails.
- Don't use a font other than the two brand stacks, or set paragraphs in the display face.
- Don't use stock Tailwind colours such as `bg-purple-500`. They do not exist here.
- Don't use success or danger to mean Yes or No, or Yes and No colours for status.
- Don't add a second filled orchid button to a view.
- Don't reach for the generic AI look: gradient text, one accented word in a headline, an eyebrow
  above every heading, identical cards with one shadow, fade-up on every section, an arrow on
  every link.
- Don't invent volume, users, endorsements, dates or live features. Unfinished work says
  "coming soon".
