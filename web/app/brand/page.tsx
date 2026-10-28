import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import * as Icons from "@/components/icons";
import { Button, Eyebrow, LinkButton, Notice, Price, SplitMeter, StateBadge, StatTile } from "@/components/ui";
import { DeltaChip } from "@/components/Featured";
import { MarketCard } from "@/components/MarketCard";
import { CategoryGlyph, MarketIcon, categoryColours } from "@/components/MarketIcon";
import { MarketSeal } from "@/components/MarketSeal";
import { Sigil } from "@/components/Sigil";
import { CATEGORIES, OTHER } from "@/lib/categories";
import type { MarketView } from "@/lib/market";
import { color, tokens, type ColorRole } from "@/lib/tokens";

export const metadata: Metadata = {
  title: "Brand | Dragons Market",
  description: "The Dragons Market living style guide: colours, type, layout, icons and components, read from the design tokens.",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  { id: "logo", title: "Logo" },
  { id: "colour", title: "Colour" },
  { id: "typography", title: "Typography" },
  { id: "layout", title: "Layout, shape and depth" },
  { id: "motion", title: "Motion" },
  { id: "icons", title: "Icons" },
  { id: "components", title: "Components" },
] as const;

type CategoryRole = Extract<ColorRole, `category-${string}`>;
const ROLE_GROUPS = ["Surfaces", "Text", "Brand and action", "Outcomes", "Status", "Categories", "Crest"] as const;
type RoleGroup = (typeof ROLE_GROUPS)[number];

// Keyed by every non-category role, so a role added to tokens.json fails the type check until it has a group.
const GROUP_OF: Record<Exclude<ColorRole, CategoryRole>, Exclude<RoleGroup, "Categories">> = {
  bg: "Surfaces", surface: "Surfaces", raised: "Surfaces", border: "Surfaces", "border-input": "Surfaces",
  text: "Text", "text-muted": "Text", "on-accent": "Text", "on-council": "Text",
  brand: "Brand and action", "brand-soft": "Brand and action", accent: "Brand and action", "accent-hover": "Brand and action",
  focus: "Brand and action", council: "Brand and action", "council-soft": "Brand and action",
  yes: "Outcomes", "yes-soft": "Outcomes", no: "Outcomes", "no-soft": "Outcomes",
  success: "Status", danger: "Status", "danger-soft": "Status", warning: "Status", "warning-soft": "Status", info: "Status", "info-soft": "Status",
  crest: "Crest",
};
const isCategoryRole = (role: ColorRole): role is CategoryRole => role.startsWith("category-");
const groupOf = (role: ColorRole): RoleGroup => (isCategoryRole(role) ? "Categories" : GROUP_OF[role]);
const ROLES = Object.keys(tokens.color) as ColorRole[];

type TypeStyleName = keyof typeof tokens.typeStyles;
const TYPE_SAMPLES: Record<TypeStyleName, string> = {
  "odds-hero": "71%",
  "market-title": "Will the Fed raise rates at its next meeting?",
  "page-title": "Markets with their rules on the front",
  "card-title": "Will Bitcoin close above 150,000 dollars on 31 December?",
  price: "200.00 mUSD",
  heading: "How this market resolves",
  body: "Resolves Yes if the Federal Reserve announces a higher target range at the meeting that follows this market's opening. Resolves No otherwise.",
  ui: "Buy Yes",
  meta: "Closes 30 Jan, 21:08 · 1,240.00 mUSD in play",
  identifier: "7f3a9c1e5b2d48f6a0c3e9b1d7f2a6c48e1b5d9f3a7c0e2b6d4f8a1c3e5b7d90",
};

// A type style names a scale step ("4xl", "tight", "title") or a raw CSS value; scale steps become their variable.
const scaled = (scale: Record<string, string>, prefix: string, value: string | undefined) =>
  value === undefined ? undefined : value in scale ? `var(--${prefix}-${value})` : value;

const DURATION_USE: Record<keyof typeof tokens.duration, string> = {
  1: "Press feedback",
  2: "Hover, colour and border changes",
  3: "Small components opening",
  4: "Entrances and panels",
  5: "The page's one orchestrated moment",
};
const EASING_USE: Record<keyof typeof tokens.easing, string> = {
  out: "Most movement: things arrive quickly and settle",
  "in-out": "Movement that starts and ends at rest",
  emph: "The crest and seals only",
};
const RADIUS_USE: Record<keyof typeof tokens.radius, string> = {
  xs: "Keys and focus rings",
  sm: "Buttons",
  md: "Inputs and outcome buttons",
  lg: "Cards and panels",
  pill: "Status pills and tabs",
};
const CONTROL_USE: Record<keyof typeof tokens.control, string> = {
  sm: "Compact buttons in dense rows",
  md: "Default controls and the minimum touch target",
  lg: "The trade ticket's main action and inputs",
};

const SAMPLE_HASH = "7f3a9c1e5b2d48f6a0c3e9b1d7f2a6c48e1b5d9f3a7c0e2b6d4f8a1c3e5b7d90";
const NS_PER_MS = 1_000_000n;
const SAMPLE_MARKET: MarketView = {
  id: "sample",
  title: "Will the Fed raise rates at its next meeting?",
  rule_text: "Resolves Yes if the Federal Reserve announces a higher target range at its next meeting. Resolves No otherwise.",
  resolution_source: "federalreserve.gov",
  void_policy: "Void if the meeting does not take place.",
  category: "economy",
  subcategory: "fed",
  rule_hash: SAMPLE_HASH,
  price_rule: null,
  close_at: String(BigInt(Date.UTC(2027, 0, 30, 21, 8)) * NS_PER_MS),
  resolve_by: String(BigInt(Date.UTC(2027, 1, 6, 21, 8)) * NS_PER_MS),
  status: "open",
  registered: true,
  outcome: null,
  refunds: false,
  price_yes: "710000",
  price_no: "290000",
  yes_shares: "1044860000",
  no_shares: "667770000",
  holders: 0, pruned: false,
  locked: "1240000000",
};

const ICONS = Object.entries(Icons).filter((entry): entry is [string, Icons.AppIcon] => typeof entry[1] === "function");
const VARIANTS = ["Linear", "Bulk", "Bold"] as const satisfies readonly Icons.IconVariant[];
const ICON_SIZES = [16, 20, 24] as const;

const titleCase = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");

export default function BrandPage() {
  return <div className="brand-page page-content">
    <header className="brand-hero">
      <span className="brand-hero-lockup" aria-hidden="true"><span className="brand-mark" /><span className="brand-wordmark" /></span>
      <h1 className="brand-hero-title">Living style guide</h1>
      <p className="brand-hero-lead">Every value here is read from <code>design/tokens.json</code> and every component is the one the product ships. Switch the theme in the header to check both.</p>
      <nav className="brand-toc" aria-label="On this page">
        <ul>{SECTIONS.map(s => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ul>
      </nav>
    </header>

    <Section id="logo" lead="The crest beside the wordmark. Mint on dark grounds, mint deep on light. Clear space is half the crest's height; the crest is at least 20px tall and the lockup at least 120px wide.">
      <ul className="brand-logo-grid">
        {(["dark", "light"] as const).map(ground => <li key={`lockup-${ground}`}>
          <div className="brand-ground" data-ground={ground}><span className="brand-lockup"><span className="brand-mark" /><span className="brand-wordmark" /></span></div>
          <p>Lockup on {ground === "dark" ? "night" : "bone"}</p>
        </li>)}
        {(["dark", "light"] as const).map(ground => <li key={`crest-${ground}`}>
          <div className="brand-ground" data-ground={ground}><span className="brand-mark brand-crest-alone" /></div>
          <p>Crest alone on {ground === "dark" ? "night" : "bone"}</p>
        </li>)}
      </ul>
    </Section>

    <Section id="colour" lead="Orchid and mint on a purple-black ground. Product code uses roles, never brand names. Each role shows its live colour; the value for the current theme is the one in full colour.">
      <h3 className="brand-subtitle">Brand colours</h3>
      <ul className="brand-swatches brand-swatches-brand">
        {Object.entries(tokens.brand).map(([name, b]) => <li key={name} className="brand-swatch">
          <span className="brand-swatch-chip" style={{ background: `var(--brand-${name})` }} />
          <div>
            <p className="brand-swatch-name">{titleCase(name)}</p>
            <p className="brand-swatch-token"><code>--brand-{name}</code> <code>{b.value}</code></p>
            <p className="brand-swatch-desc">{b.description}</p>
          </div>
        </li>)}
      </ul>
      {ROLE_GROUPS.map(group => <div key={group}>
        <h3 className="brand-subtitle">{group}</h3>
        <ul className="brand-swatches">
          {ROLES.filter(role => groupOf(role) === group).map(role => <li key={role} className="brand-swatch">
            <span className="brand-swatch-chip" style={{ background: `var(--${role})` }} />
            <div>
              <p className="brand-swatch-name"><code>{role}</code></p>
              <p className="brand-swatch-desc">{tokens.color[role].description}</p>
              <p className="brand-hex"><span data-for="dark">Dark <code>{color(role, "dark")}</code></span><span data-for="light">Light <code>{color(role, "light")}</code></span></p>
            </div>
          </li>)}
        </ul>
      </div>)}
    </Section>

    <Section id="typography" lead="Funnel Display for questions and numbers, IBM Plex Sans for every other word, IBM Plex Mono for machine identifiers only. Sentence case everywhere.">
      <ul className="brand-type-list">
        {Object.entries(tokens.typeStyles).map(([name, s]) => {
          const tracking = "tracking" in s ? s.tracking : undefined;
          const style: CSSProperties = {
            fontFamily: `var(--font-${s.font}-stack)`,
            fontSize: scaled(tokens.size, "fs", s.size),
            fontWeight: s.weight,
            lineHeight: scaled(tokens.leading, "lh", s.leading),
            letterSpacing: scaled(tokens.tracking, "track", tracking),
          };
          return <li key={name} className="brand-type-row">
            <div className="brand-type-spec">
              <p className="brand-swatch-name"><code>{name}</code></p>
              <p className="brand-type-meta">{tokens.font[s.font as keyof typeof tokens.font].family} · {s.size} · {s.weight}</p>
              <p className="brand-swatch-desc">{s.use}</p>
            </div>
            <p className="brand-type-sample" data-style={name} style={style}>{TYPE_SAMPLES[name as TypeStyleName]}</p>
          </li>;
        })}
      </ul>
    </Section>

    <Section id="layout" lead="A 4px grid. Radius follows hierarchy, from keys to cards. Three elevations, derived from the theme.">
      <h3 className="brand-subtitle">Spacing</h3>
      <ul className="brand-scale">
        {Object.entries(tokens.space).map(([step, value]) => <li key={step}>
          <code>--s-{step}</code><span className="brand-scale-value">{value}</span>
          <span className="brand-space-bar" style={{ width: `var(--s-${step})` }} />
        </li>)}
      </ul>
      <h3 className="brand-subtitle">Radius</h3>
      <ul className="brand-tiles">
        {Object.entries(tokens.radius).map(([name, value]) => <li key={name}>
          <span className="brand-radius-box" style={{ borderRadius: `var(--r-${name})` }} />
          <p><code>--r-{name}</code> {value}</p>
          <p className="brand-swatch-desc">{RADIUS_USE[name as keyof typeof tokens.radius]}</p>
        </li>)}
      </ul>
      <h3 className="brand-subtitle">Control heights</h3>
      <ul className="brand-tiles">
        {Object.entries(tokens.control).map(([name, value]) => <li key={name}>
          <span className="brand-control-bar" style={{ height: `var(--control-${name})` }} />
          <p><code>--control-{name}</code> {value}</p>
          <p className="brand-swatch-desc">{CONTROL_USE[name as keyof typeof tokens.control]}</p>
        </li>)}
      </ul>
      <h3 className="brand-subtitle">Elevation</h3>
      <ul className="brand-tiles">
        {[1, 2, 3].map(level => <li key={level}>
          <span className="brand-elev-card" style={{ boxShadow: `var(--elev-${level})` }}><code>--elev-{level}</code></span>
          <p className="brand-swatch-desc">{["Resting cards and secondary buttons", "Hovered cards, menus", "Dialogs and the one raised panel"][level - 1]}</p>
        </li>)}
      </ul>
    </Section>

    <Section id="motion" lead="Motion explains a change or marks the one ceremony on a page. Animate opacity and transform, never layout. Reduced motion sets every duration to zero.">
      <div className="brand-table-wrap">
        <table className="brand-table">
          <caption className="sr-only">Durations</caption>
          <thead><tr><th scope="col">Duration</th><th scope="col">Value</th><th scope="col">Use</th></tr></thead>
          <tbody>{Object.entries(tokens.duration).map(([step, value]) => <tr key={step}><td><code>--dur-{step}</code></td><td className="num">{value}</td><td>{DURATION_USE[step as keyof typeof tokens.duration]}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="brand-table-wrap">
        <table className="brand-table">
          <caption className="sr-only">Easings</caption>
          <thead><tr><th scope="col">Easing</th><th scope="col">Value</th><th scope="col">Use</th></tr></thead>
          <tbody>{Object.entries(tokens.easing).map(([name, value]) => <tr key={name}><td><code>--ease-{name}</code></td><td><code className="brand-wrap-code">{value}</code></td><td>{EASING_USE[name as keyof typeof tokens.easing]}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="brand-swatch-desc">Stagger between items in a list: <code>--stagger</code> {tokens.stagger}.</p>
    </Section>

    <Section id="icons" lead="Phosphor, imported only through components/icons.tsx. Linear by default, Bulk for decorative and hero icons, Bold for a selected state. 16px inline with text, 20px in controls, 24px standalone. Icons inherit the text colour.">
      <h3 className="brand-subtitle">Sizes and variants</h3>
      <div className="brand-table-wrap">
        <table className="brand-table brand-icon-matrix">
          <caption className="sr-only">One icon at each size and variant</caption>
          <thead><tr><th scope="col">Size</th>{VARIANTS.map(v => <th key={v} scope="col">{v}</th>)}</tr></thead>
          <tbody>{ICON_SIZES.map(size => <tr key={size}><th scope="row" className="num">{size}px</th>{VARIANTS.map(v => <td key={v}><span className="brand-icon-set"><Icons.Star size={size} variant={v} /><Icons.Wallet size={size} variant={v} /><Icons.Judge size={size} variant={v} /><Icons.Clock size={size} variant={v} /></span></td>)}</tr>)}</tbody>
        </table>
      </div>
      <h3 className="brand-subtitle">Every icon</h3>
      <p className="brand-swatch-desc">Each at 24px in Linear, Bulk and Bold.</p>
      <ul className="brand-icon-grid">
        {ICONS.map(([name, Icon]) => <li key={name}>
          <span className="brand-icon-variants">{VARIANTS.map(v => <Icon key={v} size={24} variant={v} />)}</span>
          <code>{name}</code>
        </li>)}
      </ul>
    </Section>

    <Section id="components" lead="The components the product ships, in their states. Each comes with when to use it.">
      <Specimen title="Buttons" guidance="Use primary for the one main action in a view, secondary and ghost for the rest, and danger only for destructive actions. Never two primaries side by side.">
        <div className="brand-row">{(["primary", "secondary", "ghost", "danger"] as const).map(v => <Button key={v} variant={v}>{v === "danger" ? "Cancel order" : v === "primary" ? "Buy Yes" : v === "secondary" ? "View rules" : "Share"}</Button>)}</div>
        <div className="brand-row">{(["sm", "md"] as const).map(size => <Button key={size} size={size} variant="secondary">View rules, {size}</Button>)}<Button disabled>Trading coming soon</Button></div>
        <div className="brand-row brand-row-narrow"><Button size="lg">Buy Yes, lg</Button></div>
      </Specimen>
      <Specimen title="Link buttons" guidance="Use when the action takes you to another page. When it changes something in place, use a button.">
        <div className="brand-row"><LinkButton href="/">Browse markets</LinkButton><LinkButton href="/council" variant="secondary">Meet the Council</LinkButton></div>
      </Specimen>
      <Specimen title="Status pills" guidance="Use to name a market's stage in words. Not for Yes or No, and never as decoration.">
        <div className="brand-row">
          <StateBadge status="open" />
          <StateBadge status="halted" />
          <StateBadge status="resolved" />
          <StateBadge status="closed" />
          <StateBadge status="closed" caseStage="proposed" />
          <StateBadge status="closed" caseStage="disputed" />
        </div>
      </Specimen>
      <Specimen title="Notices" guidance="Info for context, warning for a deadline or risk, danger for an error that says what to do next. Not for promotion.">
        <Notice>Trading opens when the oracle registers the market.</Notice>
        <Notice tone="warning">The challenge window closes 21 Nov, 21:08.</Notice>
        <Notice tone="danger">Your wallet declined the request. Try again from the ticket.</Notice>
      </Specimen>
      <Specimen title="Prices" guidance="Prices in cents, coloured by side and always next to the word Yes or No. Muted for a side that is not selected. Amounts carry their unit instead.">
        <dl className="brand-price-list">
          <div><dt>Yes</dt><dd><Price micro="710000" side="yes" /></dd></div>
          <div><dt>No</dt><dd><Price micro="290000" side="no" /></dd></div>
          <div><dt>No, muted</dt><dd><Price micro="290000" side="no" muted /></dd></div>
        </dl>
      </Specimen>
      <Specimen title="Split meter" guidance="Use for the Yes and No split of one market, with labels where there is room. Not for any other ratio.">
        <div className="brand-stack">
          <SplitMeter yes={71} size="sm" />
          <SplitMeter yes={71} labels />
          <SplitMeter yes={38} size="lg" labels />
        </div>
      </Specimen>
      <Specimen title="Price change" guidance="Movement in points over a period, with an arrow and a word for screen readers. Status colours, never outcome colours.">
        <div className="brand-row"><DeltaChip delta={6} unit /><DeltaChip delta={-4} unit /><DeltaChip delta={0} unit /></div>
      </Specimen>
      <Specimen title="Stat tiles and eyebrows" guidance="Stat tiles for a few headline figures in a summary. An eyebrow names a page section, at most one per section, never above every heading.">
        <div className="brand-row"><Eyebrow>Your portfolio</Eyebrow><Eyebrow tone="council">Council</Eyebrow></div>
        <dl className="brand-stats"><StatTile label="Balance" value="200.00 mUSD" /><StatTile label="Open positions" value="3" /><StatTile label="Chance of Yes" value="71%" /></dl>
      </Specimen>
      <Specimen title="Categories" guidance="Name a market's category with its chip or icon. The colours stay muted so they never compete with Yes and No; not for status.">
        <ul className="brand-row brand-category-list">
          {[...CATEGORIES, OTHER].map(c => <li key={c.id}>
            <MarketIcon category={c.id} sub="" small />
            <span className="category-chip" style={categoryColours(c.id)}><CategoryGlyph category={c.id} sub="" size={15} />{c.label}</span>
          </li>)}
        </ul>
      </Specimen>
      <Specimen title="Seal and sigil" guidance="Struck from a market's rule hash, so no two markets share one. Decorative only: the hash itself is printed as text.">
        <div className="brand-row brand-seals">
          <MarketSeal hash={SAMPLE_HASH} id="7" className="brand-seal" />
          <MarketSeal hash={SAMPLE_HASH} id="7" tone="council" className="brand-seal" />
          <Sigil hash={SAMPLE_HASH} className="brand-sigil" />
        </div>
        <p className="brand-type-meta mono brand-hash">{SAMPLE_HASH}</p>
      </Specimen>
      <Specimen title="Market card" guidance="Use in market lists and grids. Not on a market's own page. This sample market is not on chain, so its links lead nowhere.">
        <div className="brand-card-sample"><MarketCard market={SAMPLE_MARKET} stage={null} index={0} /></div>
      </Specimen>
    </Section>
  </div>;
}

function Section({ id, lead, children }: { id: (typeof SECTIONS)[number]["id"]; lead: string; children: ReactNode }) {
  const title = SECTIONS.find(s => s.id === id)?.title;
  return <section id={id} className="brand-section" aria-labelledby={`${id}-title`}>
    <div className="brand-section-head"><h2 id={`${id}-title`}>{title}</h2><p>{lead}</p></div>
    {children}
  </section>;
}

function Specimen({ title, guidance, children }: { title: string; guidance: string; children: ReactNode }) {
  return <div className="brand-specimen">
    <div className="brand-specimen-head"><h3>{title}</h3><p>{guidance}</p></div>
    <div className="brand-specimen-body">{children}</div>
  </div>;
}
