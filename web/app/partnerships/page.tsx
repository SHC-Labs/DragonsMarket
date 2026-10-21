import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PageLandmark } from "@/components/PageHeader";
import { ArrowUpRight } from "@/components/icons";

export const metadata: Metadata = {
  title: "Partnerships | Dragons Market",
  description: "Our planned partnership with Degen Arena, a crypto gaming platform.",
};
const games = [
  { name: "Moonshot", slug: "moonshot", type: "Live rounds", description: "The multiplier rises until it crashes. Cash out before the crash." },
  { name: "Blackjack", slug: "blackjack", type: "Classic cards", description: "Play against the dealer. Hit, stand, split or double." },
  { name: "Plinko", slug: "plinko", type: "Pick your risk", description: "Choose the number of rows and your risk level, then drop a ball down the board." },
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
      <figure className="partner-hero-art">
        <Image src="/partners/degen-arena/moonshot.webp" alt="Degen Arena’s illustrated mascot riding a red rocket through a star-filled sky" width={3048} height={1828} priority unoptimized />
      </figure>
    </section>
    <section className="partner-games" aria-labelledby="partner-games-title">
      <div className="partner-section-heading"><h2 id="partner-games-title">Games on Degen Arena</h2><p>Read the rules before you play.</p></div>
      <div className="partner-game-grid">{games.map(game => <a key={game.slug} className="partner-game" href={`${site}/how-it-works/${game.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`${game.name}: read the game guide on Degen Arena (opens in a new tab)`}>
        <div className="partner-game-art"><Image src={`/partners/degen-arena/${game.slug}.webp`} alt={`${game.name} game artwork by Degen Arena`} width={3048} height={1828} unoptimized /></div>
        <div className="partner-game-copy"><h3>{game.name}<ArrowUpRight size={20} /></h3><p>{game.description}</p><span className="partner-guide-link">Read the game guide</span></div>
      </a>)}</div>
    </section>
    <p className="partner-update">We will post the partnership details here once they are confirmed.</p>
    <p className="partner-fine-print">Degen Arena is a separate platform with its own rules and terms. Games involve financial risk. Read the rules and play responsibly.</p>
  </div>;
}
