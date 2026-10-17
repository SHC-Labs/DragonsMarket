import Link from "next/link";

export function Footer() {
  return (
    <footer className="mt-10 border-t border-border">
      <div className="mx-auto flex max-w-[var(--page-max)] flex-col gap-6 px-[var(--gutter)] py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-[26.25rem]">
          <div className="display text-[1.75rem] leading-8">The Council</div>
          <p className="mb-0 mt-2 text-sm text-muted">
            Prediction markets on NEAR. The rules are fixed before trading, and disputes are decided in public.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-6 text-sm text-muted">
          <Link href="/">Markets</Link>
          <Link href="/watchlist">Watchlist</Link>
          <Link href="/council">Council</Link>
          <Link href="/membership">Membership</Link>
          <Link href="/portfolio">Portfolio</Link>
          <Link href="/partnerships">Partnerships</Link>
        </nav>
      </div>
    </footer>
  );
}
