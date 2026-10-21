import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PageLandmark } from "@/components/PageHeader";
import { ArrowUpRight } from "@/components/icons";
import { ArenaHero, GameHint } from "@/components/ArenaArt";

export const metadata: Metadata = {
  title: "Partnerships | Dragons Market",
  description: "Meet the projects partnering with Dragons Market, starting with Degen Arena.",
};
const games = [
  { name: "Moonshot", slug: "moonshot", type: "Live rounds", description: "Watch the multiplier climb. Cash out before the crash to lock in your result." },
  { name: "Blackjack", slug: "blackjack", type: "Classic cards", description: "Take a seat against the dealer. Hit, stand, split or double: every hand gives you a decision." },
  { name: "Plinko", slug: "plinko", type: "Pick your risk", description: "Choose your rows and risk level, then follow each ball down the board to its final bucket." },
];
const site = "https://degenarena.gg";

export default function PartnershipsPage() {
  return <div className="partnership-page page-content">
    <PageLandmark title="Partnerships" />
    <section className="partner-hero" aria-labelledby="partner-title">
      <div className="partner-intro">
        <div className="partner-logos" role="group" aria-label="Partnership brands">
          <Link href="/" className="partner-dragon-logo" aria-label="Dragons Market home"><span className="brand-mark" aria-hidden="true" /></Link>
          <span className="partner-logo-separator" aria-hidden="true">×</span>
          <a href={site} target="_blank" rel="noopener noreferrer" className="partner-arena-logo" aria-label="Degen Arena (opens in a new tab)"><Image src="/partners/degen-arena/logo.webp" alt="Degen Arena" width={3000} height={2500} preload unoptimized /></a>
        </div>
        <span className="partner-status">Partnership coming soon</span>
        <h2 id="partner-title">Degen Arena</h2>
        <p className="partner-lead">Degen Arena is a crypto gaming platform with blackjack, Moonshot and Plinko. We’re preparing a partnership between our communities.</p>
        <a className="partner-primary" href={site} target="_blank" rel="noopener noreferrer">Explore Degen Arena <ArrowUpRight size={20} /></a>
      </div>
      <ArenaHero>
        <Image src="/partners/degen-arena/moonshot.webp" alt="Degen Arena’s illustrated mascot riding a red rocket through a star-filled sky" width={3048} height={1828} priority unoptimized />
      </ArenaHero>
    </section>
    <div className="arena-marquee" aria-hidden="true">{[0, 1].map(row => <div key={row} className="arena-marquee-row">{Array.from({ length: 4 }, (_, i) => <span key={i}>{games.map((g, j) => { const n = row * 12 + i * 3 + j; return <b key={g.slug} style={{ "--dx": `${((n * 37) % 11) - 5}px`, "--dy": `${((n * 53) % 9) - 4}px`, "--dur": `${5 + ((n * 29) % 7)}s`, "--delay": `${-((n * 17) % 9)}s` } as React.CSSProperties}>{g.name}</b>; })}</span>)}</div>)}</div>
    <section className="partner-games" aria-labelledby="partner-games-title">
      <div className="partner-section-heading"><h2 id="partner-games-title">Games on Degen Arena</h2><p>Read the rules before you play.</p></div>
      <div className="partner-game-grid">{games.map(game => <a key={game.slug} className="partner-game" href={`${site}/how-it-works/${game.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`${game.name}: read the game guide on Degen Arena (opens in a new tab)`}>
        <div className="partner-game-art"><Image src={`/partners/degen-arena/${game.slug}.webp`} alt={`${game.name} game artwork by Degen Arena`} width={3048} height={1828} unoptimized /><GameHint game={game.slug} /></div>
        <div className="partner-game-copy"><h3>{game.name}<ArrowUpRight size={20} /></h3><p>{game.description}</p><span className="partner-guide-link">Read the game guide</span></div>
      </a>)}</div>
    </section>
    <p className="partner-update">Partnership details will be announced here once confirmed.</p>
    <p className="partner-fine-print">Degen Arena is a separate platform with its own rules and terms. Games involve financial risk. Read the rules and play responsibly.</p>
  </div>;
}
