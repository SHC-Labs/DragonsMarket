# Taste layout review

Status note, 2026-10-19: this is a dated review, not the current design source. Council and membership now share `/council` and one mint/forest accent. Shared venue surfaces remain purple/light; the canonical palette is [design/palette.json](design/palette.json). See [WEBSITE-REVIEW-RESPONSE.md](WEBSITE-REVIEW-RESPONSE.md) for the outside review's item-by-item status. Older sage, separate-page and reference-palette descriptions below are historical.

Applied the installed redesign-existing-projects and minimalist-ui guidance from https://github.com/Leonxlnx/taste-skill. The default Taste skill is also installed for future use. This was an existing-project layout pass, not the default v2 art-direction generation workflow.

## Constraints retained

Minimal purple identity, light and dark themes, wide screen usage, four NFT artworks in a row with pointer tilt, readable trading controls, wallet-scoped browser watchlists and factual pending NFT terms. User choices take precedence over the skills' suggested palettes. No new framework, dependencies, stock photography, fabricated activity or economic promises.

## Findings and changes

| Finding | Impact | Change |
| --- | --- | --- |
| Large vertical feature and three stacked sidebar lists delayed browsing | High | Split featured question and price chart horizontally; reduced sidebar to trending and closing soon |
| Search, status and categories competed as repeated pills | Medium | Grouped controls into one quiet toolbar with clearer selected states |
| Featured section competed with filters for the first screen | Medium | Market spotlight comes before the browsing toolbar |
| Card entrance delays made the grid appear empty | High | Cards render immediately, with consistent two-line title space |
| Membership repeated an image above the complete artwork row | Medium | Replaced the duplicate with a concise launch-details panel |
| Benefits, FAQ and Council sections used unrelated alignments | Medium | Shared label/content grid and consistent text measures |
| Juror metadata was too small | Medium | Increased roster text sizes; no invented panel members |
| Mobile navigation wrapped to a second line | Medium | Compact single-row navigation with horizontal overflow fallback |

## Validation

Browser reviewed desktop and phone screenshots. Checked all six routes at 320, 390, 768, 1024, 1440 and 1920 pixels in dark mode, and 320, 768, 1024 and 1440 pixels in light mode. Verified search, status filters, watchlist saving, artwork tilt, FAQ expansion, theme switching and live quote rendering. Wallet testing used local account previews; no signed transactions were submitted. Local chain was restored for verification.

This is an expert review, not a measured usability study or evidence of improved conversion. The wallet watchlist remains stored per account in the current browser; it does not synchronize across devices. Legal policies and production NFT launch terms still require project-owner content.
