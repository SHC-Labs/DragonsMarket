Components: NEAR prediction market, pitch-test screens

Scope: the five screens in the first build (S01 market list, S02 market page, S03 trade ticket, S05 portfolio, S09 resolution). Components for the later screens (order book, deposit and withdraw, account, admin) are listed at the bottom and not specced yet.

The look. Dark theme only. The idea is a ledger, not a casino: near-black background, bone-white text, thin rules instead of boxed cards, numbers in a monospace face, controls in black and white. Colour is kept for meaning: cyan for Yes, coral for No, amber only for "pay attention" and "in progress". There is no brand colour on buttons; the primary button is bone white with dark text.

Where it follows Polymarket and Kalshi, on purpose, and where it does not. Visitors expect a prediction market to behave like one, so the home page leads with the markets: a search bar and filter tabs, a featured market with a chart next to a trending list, and a grid of cards that each show the chance of Yes and have Yes and No buy buttons. That is the shared pattern of the category. What is ours: every market has a generated sigil drawn from its locked rule fingerprint instead of a photo; Yes is cyan and No is coral (they lean on blue and green, from memory, not re-checked); numerals are set in a serif (Instrument Serif); the trade ticket is a slip with dotted leaders; the rules sit above the ticket in a ruled terms list; the Council has its own violet look. There were no screenshots of either rival in replica/screens, so nothing here was measured from them.

Fonts are open: IBM Plex Sans for text, Instrument Serif for headlines and big numerals, JetBrains Mono for prices, amounts, hashes and account names. Icons: Lucide (MIT). No logos, icons or copy come from the rivals. The accent and the name are placeholders until replica-brand.

Design rules that every component follows:

1. Yes and No always carry their word. Colour is never the only signal.
2. Anything that can be pending, failed or final has a visible status in words. No bare spinners, no silent waiting.
3. Motion enters and stops. 120 ms for state changes, nothing loops, no shimmer, no glow, no pulsing. A transaction that is waiting shows the words "Waiting for confirmation" and the seconds elapsed, which is text updating, not animation. With reduced motion set, all transitions are 0 ms.
4. Numbers are set in the monospace face with tabular figures, so prices and amounts line up and do not jump.
5. Prices are cents, 1 to 99, written like "62¢". Amounts of money are written with two decimals and the token name, like "12.50 USDC".
6. Focus ring: 2 px, amber (the focus colour), 2 px offset. Visible on every interactive element.
7. Every touch target is at least 40 px tall.
8. Corners are softly rounded (4, 8 and 14 px, written in rem). Cards are separated by 1 px borders, not shadows. The only shadow is on pop-up menus and the chart tooltip.

Tokens are in tokens.json. Tailwind names: canvas (bg), surface, raised, border, input (border-input), fg (text), muted (text-muted), accent, on-accent, focus, danger, success, yes, yes-soft, no, no-soft, warning, warning-soft, info, info-soft. Contrast: 34 pairs checked on the dark palette, 0 below AA (python3 contrast.py tokens.json).

Button
  variants  primary (bone-white fill, dark text), secondary (transparent, 1 px border, text fg), ghost (no border, underlined text), danger (bg danger, text on-accent)
  sizes     sm 32px, md 40px, lg 48px. The trade confirm button is lg.
  states    default, hover (one step darker, 120ms), active, focus-visible (ring), disabled (surface background, muted text, cursor not-allowed, and a reason shown nearby), waiting (label changes to "Waiting for confirmation", button disabled, no spinner)
  a11y      real <button>. A disabled button that blocks the main action always has its reason as visible text next to it, because a disabled control is not announced with a reason.
  used on   S02, S03, S05, S09

Amount input
  anatomy   label above, number field, unit suffix ("USDC"), a "Max" text button, helper line below
  states    default, focus, filled, error (border danger, message below with an icon), disabled
  rules     digits and one decimal point only, six decimal places maximum (the token has six), no spinner arrows. The helper line shows the balance: "Balance 25.00 USDC".
  a11y      <input inputmode="decimal">, label tied by id, error linked with aria-describedby, the error is not colour only
  used on   S03, S05 (withdraw later)

Outcome toggle (Yes / No)
  anatomy   two segments, each shows the word and the current price: "Yes 62¢" and "No 38¢"
  states    selected Yes (yes-soft background, 2px yes border), selected No (no-soft background, 2px no border), unselected (transparent, 1px border-input), disabled (market closed). The word is in fg colour and the price is in cyan or coral.
  a11y      a radio group with two radios, arrow keys move, the label includes the word. Never colour only.
  used on   S02, S03

Price
  anatomy   a monospace number with the cent sign, coloured cyan for Yes and coral for No, with no background. In list columns the column header carries the word; in running text the word comes first: "Yes 62¢"
  variants  yes, no, neutral (muted, when the market is closed or void)
  rules     prices update in place without animation
  a11y      read as "Yes, 62 cents"
  used on   S01, S02, S05

Market card (home grid)
  anatomy   a small sigil thumbnail, the question (up to three lines), a half-circle gauge with the chance of Yes, then Yes and No buy buttons showing their prices, then a footer with the state badge, the amount in play and the close time
  buttons   Yes is cyan on a dark cyan tint, No is coral on a dark coral tint; hover fills them. They open the market with that side already chosen (?side=yes or ?side=no)
  states    open (buttons), closed (a dashed note saying what is happening: waiting for an answer, an answer waiting for a challenge, or the Council deciding), final (a "Result: Yes" line, no buttons)
  a11y      the title area is one link; the gauge has a text label ("53 percent chance of Yes"); the buttons are real links with the side in their text
  used on   S01

Featured market and Trending (home, above the grid)
  featured  the open market with the most money in play: sigil, serif title, the big chance of Yes, change since it opened, a price chart, large Yes and No buttons
  trending  a ranked list of the five open markets with the most in play (with change), then the three closing soonest, then up to three awaiting an answer
  rules     both sit above the grid only when no search or filter is active

Fluid scaling (every screen from phone to TV)
  root size  the root font size is clamp(16px, 0.5vw + 11px, 34px): 16 px on phones and tablets, about 18 px on a laptop, 20 px at 1080p and 30 px at 4K. Every size in the site is in rem, so type, spacing, cards and charts grow together
  grids      the market grid is auto-fill with a minimum card width of 18.5rem, so it picks its own column count: 1 on a phone, 2 on a tablet, 3 to 4 on a laptop, 4 to 5 at 1080p, 5 to 7 at 4K
  gutters    page gutters are clamp(1rem, 2.5vw, 5rem) and the page max width is 112rem, so a TV uses its width without stretching lines of text
  touch      on touch screens (pointer: coarse) buttons, tabs and inputs are at least 44 px tall; the page respects notches and rounded corners (safe-area insets, viewport-fit cover)
  tested     phone 390, tablet 820, laptop 1440, 1080p 1920 and 4K 3840 wide, every test at every size

State badge
  values    Open, Closed, Answer proposed, Challenged, Final, Void, Paused
  style     outlined, nearly square (2 px radius), 1 px border, no fill. Open, Closed, Final and Void use the neutral border and fg text. Answer proposed and Challenged use the amber border and text. Paused uses the coral border and text. Final never uses Yes or No colours, because a status must not look like a win or a loss.
  rules     the word is always shown. Size xs.
  used on   S01, S02, S05, S09

Rules block
  purpose   the plain rules of one market, shown before the trade ticket on S02
  anatomy   a "How this market resolves" heading, then a ruled terms list with a label column and a value column: Rule (plain words), Decided by (the named source as a link), Void if (the void policy), Locked (the time, and the rule fingerprint in mono, first 8 and last 6 characters, with a Copy button for the full value). On the market page this comes before the Resolution status and right after the title.
  states    default, expanded (long rule text is clamped at six lines with "Show all"), after resolution (adds "What happened" with the outcome and a link to the evidence)
  rules     the text is written by the market creator; the template forces all four parts. A market with an empty "What counts as void" cannot be published.
  a11y      a <section> with a heading; the hash has an accessible label "Rule fingerprint"
  used on   S02, S09

Trade ticket
  purpose   buy or sell one outcome at the market price
  anatomy   a slip: a raised panel with a dashed top edge. Inside: Buy/Sell heading in small spaced capitals, Outcome toggle, Amount input, Quote lines, Confirm button, one status line
  quote lines (all of these, always, before the button): "You pay 12.50 USDC", "You get about 19.8 Yes", "Least you will get 19.4 Yes" (the minimum you will accept, from slippage), "Average price 63¢", "Fee 0.00 USDC". Each is a row with the label at the left, a dotted leader line, and the value at the right in mono.
  states    empty (no amount: lines show dashes, button disabled with reason "Enter an amount"), valid, over balance (error "You have 5.00 USDC. This costs 12.50."), market closed (all disabled, banner "Trading stopped at <time>"), paused (banner), not registered (a first-time step: "One-time storage deposit of 0.01 NEAR so this contract can remember your balance", with its own button), waiting (after confirm: status line "Waiting for confirmation, 4s"), done ("Done. You hold 19.8 Yes shares" with a link to the portfolio), failed (status line with the reason and "Nothing was taken from your balance" when true)
  rules     the quote is requested again when the amount changes after 300 ms of no typing, and while it is out of date the button is disabled and the quote lines are muted
  a11y      quote lines are in an aria-live="polite" region that updates when the amount settles; the status line is aria-live="polite" too
  used on   S02 (S03 is this component)

Position row
  anatomy   market title, outcome word + shares, current value, a "Redeem" or "Sell" button depending on state
  states    open (Sell), closed awaiting answer ("Waiting for the answer", no buttons), final and won ("You won 19.8 USDC", Redeem), final and lost ("Resolved No. Nothing to redeem"), void ("Void: you get back 9.90 USDC", Redeem), redeemed (muted, with amount)
  a11y      won and lost are in words, not colour
  used on   S05

Redeem button
  states    ready, waiting, done, failed. There is no deadline text anywhere. Copy: "Redeem 19.8 USDC".
  rules     always available after a market is final. The contract guarantees it and the test suite proves it.
  used on   S05, S09

Status stepper
  purpose   shows where a process is. Resolution first; deposit and withdraw later with the same pattern.
  resolution steps  Trading closed, Answer proposed, Challenge window, Final
  anatomy   a horizontal list of steps (vertical on narrow screens). Each step has a 2 px rule on top: past steps muted-grey rule and normal text, the current step an amber rule and bold text, future steps a dark rule and muted text. Under the current step: one sentence of what is happening and the time left.
  states    in progress, challenged (adds a step "Panel deciding" with the deadline), final, void, failed to apply (adds "The answer is final but the market has not updated yet. Anyone can retry." with a Retry button)
  a11y      an ordered list; the current step has aria-current="step"; time left is text, not announced every second
  used on   S09, S02 (compact)

Countdown
  rules     text only: "2h 14m left", "Ends in 40s". Updates once a minute above one hour, once a second under one minute. No animation.
  used on   S09, S02

Panel vote list
  anatomy   one row per panel member: account, vote word (Yes, No, Void, Not voted), reason text, time
  states    voting open, majority reached, deadline passed
  rules     reasons are required and shown in full
  used on   S09

Notice banner
  variants  info (info-soft), warning (warning-soft), danger (no-soft)
  anatomy   a 3 px left bar in the variant colour, one sentence, optional link or button. Nearly square corners, no fill beyond the soft tint.
  standing notices  "Testnet: play money only" (always on testnet, info), "Real money, capped at 50 USDC per account" (on mainnet test, warning), "Trading is paused" (danger), "Waiting on the network, trades may be slow" (warning, shown when a transaction has been pending past a threshold)
  a11y      role="status" for info and warning, role="alert" for danger
  used on   all screens, below the header

Wallet button
  states    not connected ("Connect wallet", primary), connecting, connected (shortened account "alice.near" and a menu with Copy address, Disconnect), wrong network ("Switch to testnet", warning)
  a11y      menu follows the standard menu button pattern
  used on   header

Empty, loading and error states for each screen
  S01  empty: "No markets yet." (this is the owner's job to fix, with no filler art). loading: the table frame with plain "Loading markets" text, no skeleton shimmer. error: "Could not load markets. Check your connection." with Retry.
  S02  not found: "This market does not exist." Loading and error as S01.
  S05  not connected: "Connect a wallet to see your positions." empty: "No positions yet." with a link to S01.
  S09  nothing proposed yet: "Nobody has proposed an answer yet. Anyone can, with a bond of <amount>." with the propose form for accounts that are connected.

The Council (the NFT dispute jury, a later phase; the first test uses a few test accounts in the same components)

Idea behind it. The owner's plan is that the dispute jury is drawn from holders of an NFT collection whose art already exists and has a dark, cult-like vibe. The design lets the Council feel like a dark order without making the venue feel like a cult, because the product sells trust in the referee. So the Council has its own colour (muted violet, the council role) and the same serif display face as the rest of the site (Instrument Serif). The Council is told apart by its violet colour: the seal, the juror cards, the verdict line and the Council band.

Rule for lore. Dark names are welcome where a plain label sits right next to them. "The Council" is the name; "Jury of 5, drawn at random" is the label. "Verdict" is the word; "Final answer: No" is the line. A person who knows nothing about the lore can still read what happened and what to do next.

Juror card
  anatomy   the member's NFT art as a square tile (64 px; a placeholder tile with the token number until the real art is wired in), the token number in mono, the account, the vote in words (Yes, No, Void, Not voted), the reason in full
  states    summoned (no vote yet), voted, conflicted (removed: shows "Stood down: held a position" and the reason), timed out
  a11y      the art has alt text "Council NFT number 14"; the vote is in words, not colour or art
  used on   S09, the Council page

Council seal
  purpose   a mark that appears on a market's resolution when the Council decided it, so a visitor sees at a glance that this was a dispute and not an unchallenged answer
  anatomy   a small sigil drawn as inline SVG (our own, not taken from the collection art), the word "Sealed by the Council", the date and a link to the case
  rules     static. It appears when the case ends, with no entrance effect beyond the 120 ms fade used for any state change
  used on   S02, S09, S05

Verdict line
  anatomy   serif display line under the status stepper: "Verdict: No" with a muted line "Jury of 5. 4 for No, 1 for Yes. Decided 14 Oct, 09:41." and a link to each juror's reason
  rules     the plain outcome is always in the line
  used on   S09

Council page (S15, not in the first build)
  sections  "The Council" heading with one line saying what it is; "How a case works" in five short steps; "Cases" (open cases with their deadline, then closed cases with the verdict); "Members" (a grid of NFT tiles with token number and cases served); "Record" (counts: cases decided, unanimous, overturned on appeal if appeals exist)
  rules     the page may carry the collection's art and lore. It never shows a price, a floor price, a mint button or any claim about earnings from holding. Joining the Council is described only by what members do and what they are paid for work done, as agreed in spec.md.
  a11y      the grid is a list; each tile is a link to its member page

Status stepper additions for disputes
  When a case is open the stepper gains the step "Council decides" with the sub-line "Jury of 5, drawn at random. Decision due <time>." and the Juror cards listed under it as they vote. When the case ends it shows the Verdict line and the Council seal.

Failure copy for the reasons a transaction can fail (shown in the trade ticket status line and the redeem button). Written in words a person can act on:
  market closed       "This market stopped trading at <time>."
  paused              "Trading is paused. Your balance is safe."
  too little received "The price moved. You would get less than your minimum. Try again."
  not enough balance  "You have <x>. This needs <y>."
  not registered      "Do the one-time storage step first."
  wrong token         "This market uses <token>. You sent <token>."
  other               "Something went wrong. Nothing was taken. Reference <short id>." with a copy button for the reference.
The reference is a short id from the transaction hash, so a person asking for help can say exactly which transaction.

Layout
  page width    max 1080 px, centred, 16 px side padding on phones
  header        56 px: name at left, wallet button at right
  S01           search and filter tabs under the header, a featured market beside a trending list, then the card grid (columns chosen by screen width), the three-step explainer and the Council band
  S02           two columns above 900 px: content (rules block, price, status, dispute history) and the trade ticket, 360 px wide, sticky. Below 900 px the ticket moves under the question and the rules block, and a "Trade" button in a bottom bar opens it.
  spacing       4 px base: 4, 8, 12, 16, 24, 32, 48, 64. Gaps inside a card 12 or 16, between cards 24.

Not specced yet, because they are not in the first build: order book ladder, deposit and withdraw panels (they use the Status stepper), account and verification, admin and market creation, price chart (a simple line chart comes after the first test, drawn from the contract's trade events), leaderboard, comments.

Built primitives. Built in web/ as real components (see web/components). The static preview.html shows the first design pass only and is out of date; the running site is the reference.

Older note, kept for the record: not built yet. This machine has no Next.js project, no browser to screenshot with, and the app is created in /replica-build. A static page, design/preview.html, shows the tokens and the main components in plain HTML and CSS so the look can be reviewed now.
