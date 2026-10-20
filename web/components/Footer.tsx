import { Brand } from "./Brand";
import Link from "next/link";

// TODO before launch: replace these mock destinations with the official X profile, Docs and API URLs.
const footerLinks: { label: string; href: string; icon?: "x" }[] = [
  { label: "X (Twitter)", href: "#x", icon: "x" },
  { label: "Docs", href: "#docs" },
  { label: "API", href: "#api" },
];

function XMark() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26L22.827 21.75H16.17l-5.214-6.817-5.964 6.817H1.682l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></svg>;
}

export function Footer() {
  return (
    <footer className="mt-10 border-t border-border">
      <div className="mx-auto flex max-w-[var(--page-max)] flex-col gap-6 px-[var(--gutter)] py-10 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <Brand variant="footer" />
          <p className="mb-0 mt-2 text-sm text-muted sm:whitespace-nowrap">
            The world moves and every outcome has a market. Take your position.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-1 lg:items-end">
          <nav aria-label="Community and resources" className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted lg:justify-end">
            {footerLinks.map(({ label, href, icon }) => (
              <a key={label} href={href} title="Placeholder link" className="inline-flex min-h-11 items-center gap-2 no-underline hover:text-fg">
                {icon === "x" && <XMark />}{label}
              </a>
            ))}
          </nav>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted lg:justify-end">
            <Link href="/privacy" className="inline-flex min-h-11 items-center no-underline hover:text-fg">Privacy Policy</Link>
            <Link href="/terms" className="inline-flex min-h-11 items-center no-underline hover:text-fg">Terms of Use</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
