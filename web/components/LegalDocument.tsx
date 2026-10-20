import Link from "next/link";
import type { ReactNode } from "react";

export interface LegalSection {
  id: string;
  title: string;
  content: ReactNode;
}

export function LegalDocument({ title, related, intro, sections }: {
  title: string;
  related: { href: string; label: string };
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return <article className="legal-document page-content" aria-labelledby="legal-title">
    <header className="legal-heading">
      <h1 id="legal-title">{title}</h1>
      <div className="legal-meta">
        <p>Last updated <time dateTime="2026-10-19">19 October 2026</time></p>
        <Link href={related.href}>{related.label}</Link>
      </div>
    </header>
    <div className="legal-intro">{intro}</div>
    <details className="legal-contents">
      <summary>On this page</summary>
      <nav aria-label={`${title} sections`}>
        <ol>{sections.map(section => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ol>
      </nav>
    </details>
    {sections.map(section => <section className="legal-section" key={section.id} aria-labelledby={section.id}>
      <h2 id={section.id}>{section.title}</h2>
      {section.content}
    </section>)}
  </article>;
}
