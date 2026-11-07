import { Brand } from "./Brand";
import Link from "next/link";

// Docs and API destinations are not configured yet.
const footerLinks: { label: string; href: string; icon?: "x" }[] = [
  { label: "X (Twitter)", href: "https://x.com/DragonsOnNear", icon: "x" },
  { label: "Docs", href: "#docs" },
  { label: "API", href: "#api" },
];

function XMark() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26L22.827 21.75H16.17l-5.214-6.817-5.964 6.817H1.682l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></svg>;
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Brand variant="footer" />
          <p>The world moves and every outcome has a market. Take your position.</p>
        </div>
        <div className="site-footer-links">
          <nav aria-label="Community and resources">
            <h2 className="eyebrow">Community</h2>
            {footerLinks.map(({ label, href, icon }) => (
              <a key={label} href={href} title={href.startsWith("#") ? "Placeholder link" : undefined}>{icon === "x" && <XMark />}{label}</a>
            ))}
          </nav>
          <nav aria-label="Legal">
            <h2 className="eyebrow">Legal</h2>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Use</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
