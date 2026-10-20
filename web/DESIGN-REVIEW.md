# Design and content review

Status note, 2026-10-19: the current site uses one shared page header and type scale, the Sora Dragons Market wordmark and dragon crest, purple venue themes and a complete mint/forest Council theme. Council membership and cases share `/council`; `/membership` redirects to its membership section. This supersedes the older visual directions recorded below. Colour tokens live in [design/palette.json](design/palette.json); the shared hierarchy lives in `components/PageHeader.tsx` and `app/studio.css`.

Scope: Markets, market detail, Council, Membership and Portfolio. Expert review using heuristic-evaluation, content-strategy and ux-writing skills. This is a design review, not a user study.

| Finding | Severity | Action |
| --- | --- | --- |
| Home introduction explained controls before motivating a visit | 2 | Added a stronger headline, topic context and a concrete price example |
| Site identity did not connect markets with the NFT project | 2 | Added contextual links to public case records and membership |
| Membership opened with administrative language | 2 | Led with artwork and project participation, retained pending launch and economics |
| Portfolio empty state gave little reason to connect | 2 | Explained tracking, available funds and redemption |
| Three onboarding columns were cramped on tablets | 2 | Stack the guide until desktop width |

Voice: confident at the page entrance, precise at trading and settlement. Avoid invented volume, endorsements, urgency, guaranteed returns and claims that planned NFT features are live. Market rules, prices and transaction labels remain operational rather than promotional.

Keep: purple light/dark themes, visible Yes/No outlines, live market data, searchable categories, public dispute records, responsive touch controls.

Follow-up: launch supply, pricing, eligibility and distribution terms must come from the project team. Validate the revised messaging with users; an expert review cannot establish conversion lift.

## Whole-site minimalism pass, 2026-10-19

Skills applied: [redesign-existing-projects](/home/nameless/.agents/skills/redesign-skill/SKILL.md) and [minimalist-ui](/home/nameless/.agents/skills/minimalist-skill/SKILL.md). The owner's approved fonts, palette and artwork take precedence over the skills' generic style suggestions. This is an expert review, not user-research evidence.

| Observed inconsistency | Applied change |
| --- | --- |
| Desktop page titles ranged from 30px on Watchlist to 84px on Partnerships | One visible title component, 32px on phones and a fluid 32-44px desktop scale, weight 500 and one line-height |
| Council had its own section menu and repeated small introductory labels | Removed that menu, the NFT eyebrow and redundant section labels; kept links where they explain an action |
| Partnerships looked like a separate marketing landing page | Shared page title, smaller partner heading, original logo pairing, one paragraph and a proportionate image without a visible caption |
| Empty account screens used different designs | Shared crest, surface, heading, explanation and actions for Watchlist and Portfolio |
| Lower Council sections and market rules had unrelated heading sizes | Shared section scale and consistent body text, with metadata kept smaller |
| Old visual language survived in data views | Market category icons now match between grid, detail and portfolio; removed exaggerated resting card shadows and gradients |
| Missing-page and missing-market screens fell outside the system | Shared title, explanation and a route back to the markets |

Retained: featured Visx chart and carousel, compact Yes/No grid cards, Watch and Share controls, pagination, wallet-specific watchlists, four NFT images with pointer tilt, all public case records, readable light/dark themes and disabled contract integration points.

Validation: all page entrances checked in both themes at phone and desktop widths; automated comparisons include phone, tablet and desktop. Check heading position and size, no duplicate heading, no overflow, branding, navigation, disclosures and partner links. Wallet-connected Portfolio/Watchlist and lower Council sections are also inspected against the local chain. No financial transactions are required for this review.

## Header guide follow-up, 2026-10-19

Per owner request, remove subtitles from Markets, Watchlist, Council, Partnerships and Portfolio. Their page introductions now contain the title and any relevant action. Keep the footer tagline and useful error/empty-state explanations.

Move both the inline market help and the lower onboarding block into one How it works dialog, opened from the shared header immediately before the theme toggle. The native dialog uses the current route theme, three short steps and a link to Council result handling. It closes with its close control, Got it, Escape, an outside click or navigation. Keyboard focus stays inside while open and returns to the trigger on close; the background cannot scroll. Applied the keyboard-navigation skill for these behaviours. No financial action is enabled by the guide.

## Content-first page entrances, 2026-10-19

The latest owner instruction removes the repeated visible page title and its reserved space from Markets, Watchlist, Council, Partnerships and Portfolio. The active navigation item identifies the current page. These routes keep a screen-reader-only h1 and matching top spacing, then start with their actual content. Market questions, membership terms, case records, empty-state explanations and recovery-screen headings retain their meaning and hierarchy. The shared header guide remains available beside the theme toggle.
