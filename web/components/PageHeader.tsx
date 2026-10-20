import type { ReactNode } from "react";

/** Visible heading for recovery screens. Main routes use PageLandmark. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return <header className="page-header">
    <div className="page-header-copy"><h1 className="page-title">{title}</h1>{description && <p className="page-description">{description}</p>}</div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </header>;
}

/** Keeps the page identifiable to screen readers without repeating the navigation visually. */
export function PageLandmark({ title }: { title: string }) {
  return <h1 className="sr-only">{title}</h1>;
}

export function AccountEmptyState({ title, description, actions }: { title: string; description: string; actions: ReactNode }) {
  return <section className="account-empty">
    <span className="brand-mark" aria-hidden="true" />
    <div><h2>{title}</h2><p>{description}</p><div className="account-empty-actions">{actions}</div></div>
  </section>;
}
