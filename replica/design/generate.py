#!/usr/bin/env python3
"""Regenerates tokens.css and tailwind-theme.css from tokens.json. Run: python3 generate.py"""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
t = json.load(open(os.path.join(here, "tokens.json")))

css = ["/* Generated from tokens.json by generate.py. Edit the JSON, not this file. Dark theme only. */", ":root {", "  color-scheme: dark;"]
css += [f"  --{k}: {v};" for k, v in t["color"].items()]
css += [f"  --font-sans-stack: {t['font']['sans']};", f"  --font-mono-stack: {t['font']['mono']};", f"  --font-display-stack: {t['font']['display']};"]
rem = lambda px: f"{px / 16:g}rem"  # rem, so the whole site scales with the root size (phone to TV)
css += [f"  --text-{k}-size: {rem(v['size'])};  --text-{k}-line: {rem(v['line'])};  --text-{k}-weight: {v['weight']};" for k, v in t["type"].items()]
css += [f"  --space-{i}: {v}px;" for i, v in enumerate(t["space"])]
css += [f"  --radius-{k}: {rem(v) if v < 900 else str(v) + 'px'};" for k, v in t["radius"].items()]
css += [f"  --shadow-{k}: {v};" for k, v in t["shadow"].items()]
css += [f"  --motion-{k}: {v};" for k, v in t["motion"].items()]
css += [f"  --layout-{k}: {v}px;" for k, v in t["layout"].items()]
css += ["}", "@media (prefers-reduced-motion: reduce) {\n  :root { --motion-fast: 0ms; --motion-base: 0ms; }\n}"]
open(os.path.join(here, "tokens.css"), "w").write("\n".join(css) + "\n")

names = {"bg": "canvas", "text": "fg", "text-muted": "muted", "border-input": "input"}
tw = ["/* Tailwind v4 mapping. Import after tokens.css. Utilities: bg-canvas, bg-surface, bg-raised, text-fg, text-muted, border-border, border-input, ring-focus, text-yes, bg-yes-soft, text-council, bg-council-soft, font-display ... */", '@import "tailwindcss";', "@theme inline {"]
tw += [f"  --color-{names.get(k, k)}: var(--{k});" for k in t["color"]]
tw += ["  --font-sans: var(--font-sans-stack);", "  --font-mono: var(--font-mono-stack);", "  --font-display: var(--font-display-stack);"]
tw += [f"  --text-{k}: var(--text-{k}-size);  --text-{k}--line-height: var(--text-{k}-line);" for k in t["type"]]
tw += [f"  --radius-{k}: var(--radius-{k});" for k in t["radius"]]
tw += ["  --shadow-pop: var(--shadow-pop);", "  --ease-ui: cubic-bezier(.2,.8,.2,1);", "}"]
open(os.path.join(here, "tailwind-theme.css"), "w").write("\n".join(tw) + "\n")
print("wrote tokens.css and tailwind-theme.css")
