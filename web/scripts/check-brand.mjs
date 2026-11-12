// Brand check: fails when code bypasses design/tokens.json or the shared components.
// Run with `npm run check:brand`; lib/__tests__/brand.test.ts runs it under vitest.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Files that may hold raw colours, and why.
const COLOUR_ALLOWED = {
  'app/tokens.generated.css': 'generated from design/tokens.json',
  'app/tokens.css': 'derived roles: shadows and highlights mixed from tokens',
};

// Pure black and white carry light and shadow, not brand colour: masks, highlights, shadows.
const NEUTRAL = /^(#000|#000000|#fff|#ffffff|rgba?\(\s*(0\s+0\s+0|255\s+255\s+255)\b[^)]*\))$/i;

const RULES = [
  {
    id: 'raw-colour',
    files: /\.(css|tsx?)$/,
    skip: file => file in COLOUR_ALLOWED,
    pattern: /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\([^)]*\)/gi,
    test: (match, file) => !NEUTRAL.test(match) && !(/\.tsx?$/.test(file) && /^rgba?\(\w+[,:]/.test(match)),
    fix: 'Use a colour role (var(--text), var(--yes), ...) or add the value to design/tokens.json and run npm run tokens.',
  },
  {
    id: 'raw-font',
    files: /\.(css|tsx?)$/,
    skip: file => file === 'app/tokens.generated.css',
    pattern: /font-family:\s*[^;}]+|fontFamily:\s*["'][^"']+["']/g,
    test: match => !/var\(--font-(display|sans|mono)-stack\)|inherit/.test(match),
    fix: 'Use var(--font-display-stack), var(--font-sans-stack) or var(--font-mono-stack). The brand has two families.',
  },
  {
    id: 'tailwind-palette',
    files: /\.tsx?$/,
    pattern: /\b(?:bg|text|border|fill|stroke|from|via|to|ring|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?\b|-\[(?:#|rgb|hsl|oklch)[^\]]*\]/g,
    fix: 'Tailwind default colours are reset. Use the token utilities in app/theme.css (bg-surface, text-muted, text-yes, ...).',
  },
  {
    id: 'icon-import',
    files: /\.tsx?$/,
    skip: file => file === 'components/icons.tsx',
    pattern: /from\s+["']@phosphor-icons\/react[^"']*["']/g,
    fix: 'Import icons from "@/components/icons". Add a new Phosphor icon there first.',
  },
  {
    id: 'em-dash',
    files: /\.tsx?$/,
    pattern: /—/g,
    fix: 'The brand voice uses plain punctuation. Rewrite with a full stop, comma or colon.',
  },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const stripComments = (source, file) =>
  source.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/.*/g, line => (/\.css$/.test(file) ? line : line.replace(/(^|[^:"'`])\/\/.*$/, '$1')));

/** Checks one file's source. Exported so the test can prove each rule fires. */
export function checkSource(file, source) {
  const found = [];
  const text = stripComments(source, file);
  for (const rule of RULES) {
    if (!rule.files.test(file) || rule.skip?.(file)) continue;
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.test && !rule.test(m[0], file)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      found.push({ rule: rule.id, file, line, match: m[0].slice(0, 60), fix: rule.fix });
    }
  }
  return found;
}

export function checkRepo() {
  const files = ['app', 'components', 'lib'].flatMap(d => [...walk(join(ROOT, d))])
    .map(p => relative(ROOT, p).split(sep).join('/'))
    .filter(f => !f.includes('__tests__'));
  return files.flatMap(f => checkSource(f, readFileSync(join(ROOT, f), 'utf8')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkRepo();
  for (const p of problems) console.error(`${p.file}:${p.line} [${p.rule}] ${p.match}\n  ${p.fix}`);
  if (problems.length) { console.error(`\n${problems.length} brand problem(s).`); process.exit(1); }
  console.log('Brand check passed.');
}
