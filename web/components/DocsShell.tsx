import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "@/components/icons";

export interface DocPage {
  slug: string;
  title: string;
  group: string;
  description: string;
  content: ReactNode;
}

const hrefOf = (base: string, page: DocPage) => (page.slug ? `${base}/${page.slug}` : base);

function DocsNav({ base, pages, current, label }: { base: string; pages: DocPage[]; current: DocPage; label: string }) {
  const groups = [...new Set(pages.map(page => page.group))];
  return <nav className="docs-nav" aria-label={label}>
    {groups.map(group => <div className="docs-nav-group" key={group}>
      <p className="docs-nav-heading">{group}</p>
      <ul>
        {pages.filter(page => page.group === group).map(page => <li key={page.slug}>
          <Link href={hrefOf(base, page)} aria-current={page === current ? "page" : undefined}>{page.title}</Link>
        </li>)}
      </ul>
    </div>)}
  </nav>;
}

export function DocsShell({ area, base, pages, slug }: { area: string; base: string; pages: DocPage[]; slug: string }) {
  const index = pages.findIndex(page => page.slug === slug);
  const current = pages[index];
  const previous = pages[index - 1];
  const next = pages[index + 1];
  return <div className="docs-layout page-content">
    <aside className="docs-sidebar">
      <DocsNav base={base} pages={pages} current={current} label={`${area} pages`} />
    </aside>
    <details className="docs-menu">
      <summary>{area} pages<span>{current.title}</span></summary>
      <DocsNav base={base} pages={pages} current={current} label={`${area} pages, menu`} />
    </details>
    <article className="docs-article" aria-labelledby="docs-title">
      <p className="eyebrow">{current.group}</p>
      <h1 id="docs-title">{current.title}</h1>
      {current.content}
      <nav className="docs-pager" aria-label="Previous and next page">
        {previous && <Link className="docs-pager-link" href={hrefOf(base, previous)}>
          <span><ArrowLeft size={16} />Previous</span>{previous.title}
        </Link>}
        {next && <Link className="docs-pager-link docs-pager-next" href={hrefOf(base, next)}>
          <span>Next<ArrowRight size={16} /></span>{next.title}
        </Link>}
      </nav>
    </article>
  </div>;
}
