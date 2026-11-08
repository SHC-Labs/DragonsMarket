# Bundled fonts

These files keep production builds independent of Google Fonts responses. The font families,
weights and CSS variables used by the website are unchanged. Full upstream character sets
are retained; no glyph subsetting or design changes are applied.

Source: [google/fonts commit 86aced91de05cd4f96a06838124cca45be337b2b](https://github.com/google/fonts/tree/86aced91de05cd4f96a06838124cca45be337b2b).

| Local file | Upstream file |
| --- | --- |
| `ibm-plex-sans.woff2` | `ofl/ibmplexsans/IBMPlexSans[wdth,wght].ttf` |
| `funnel-display.woff2` | `ofl/funneldisplay/FunnelDisplay[wght].ttf` |
| `ibm-plex-mono-400.woff2` | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf` |
| `ibm-plex-mono-500.woff2` | `ofl/ibmplexmono/IBMPlexMono-Medium.ttf` |

WOFF2 files are compressed from the pinned upstream TTF files with FontTools:

```sh
fonttools ttLib.woff2 compress INPUT.ttf -o OUTPUT.woff2
```

The three accompanying OFL license files are copied from the same upstream commit.
Keep them with the fonts when updating or redistributing the files. Updating fonts is a
reviewed source change, not a build-time download.

FontTools XML comparisons verified that glyphs, metrics, variation data and metadata match
the original TTFs. Differences are limited to the WOFF2 checksum/compression flag and removal
of the two empty Mono signature tables. Copyright and font names are preserved. See the
[OFL guidance on WOFF compression](https://openfontlicense.org/ofl-faq/#22-can-i-make-and-use-woff-web-open-font-format-versions-of-ofl-fonts).
