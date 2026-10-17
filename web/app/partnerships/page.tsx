import type { Metadata } from "next";
import Image from "next/image";
import { ArrowUpRight } from "@/components/icons";

export const metadata: Metadata = {
  title: "Partnerships | The Council",
  description: "Meet Degen Arena, our upcoming partner bringing crypto games, live rounds and player-versus-player action to the table.",
};
const games = [
  { name: "Moonshot", slug: "moonshot", type: "Live rounds", description: "Watch the multiplier climb. Cash out before the crash to lock in your result." },
  { name: "Blackjack", slug: "blackjack", type: "Classic cards", description: "Take a seat against the dealer. Hit, stand, split or double: every hand gives you a decision." },
  { name: "Plinko", slug: "plinko", type: "Pick your risk", description: "Choose your rows and risk level, then follow each ball down the board to its final bucket." },
];
const site = "https://degenarena.gg";

export default function PartnershipsPage() {
  return <div className="partnership-page">
    <div className="partner-page-heading"><p className="ritual-label">Partnerships</p><span>Meet the people we’re building alongside.</span></div>
    <section className="partner-hero" aria-labelledby="partner-title">
      <div className="partner-intro">
        <p className="partner-eyebrow">The Council <span aria-hidden="true">×</span> Degen Arena</p>
        <span className="partner-status">Partnership coming soon</span>
        <h1 id="partner-title">Meet you<br />in the arena.</h1>
        <p className="partner-lead">You know The Council for prediction markets. Meet Degen Arena, the crypto gaming platform we’re teaming up with next.</p>
        <p>From a hand of blackjack to a live Moonshot round, Degen Arena puts different ways to play in one place, with game guides that explain the rules before you start.</p>
        <a className="partner-primary" href={site} target="_blank" rel="noopener noreferrer">Explore Degen Arena <ArrowUpRight size={20} /></a>
        <span className="partner-link-note">degenarena.gg · Opens in a new tab</span>
      </div>
      <figure className="partner-hero-art">
        <Image src="/partners/degen-arena/moonshot.webp" alt="Degen Arena’s illustrated mascot riding a red rocket through a star-filled sky" width={3048} height={1828} priority unoptimized />
        <figcaption><span>Degen Arena</span><span>Crypto games. Their own kind of action.</span></figcaption>
      </figure>
    </section>
    <section className="partner-games" aria-labelledby="partner-games-title">
      <div className="partner-section-heading"><div><p className="ritual-label">Inside Degen Arena</p><h2 id="partner-games-title">Find your kind of game.</h2></div><p>A look at three games in their lineup. Explore the full site for Flip Dat, It Goes Boom and Jackpot, too.</p></div>
      <div className="partner-game-grid">{games.map(game => <a key={game.slug} className="partner-game" href={`${site}/how-it-works/${game.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`${game.name}: read the game guide on Degen Arena (opens in a new tab)`}>
        <div className="partner-game-art"><Image src={`/partners/degen-arena/${game.slug}.webp`} alt={`${game.name} game artwork by Degen Arena`} width={3048} height={1828} unoptimized /></div>
        <div className="partner-game-copy"><p className="ritual-label">{game.type}</p><h3>{game.name}<ArrowUpRight size={20} /></h3><p>{game.description}</p><span className="partner-guide-link">Read the game guide</span></div>
      </a>)}</div>
    </section>
    <section className="partner-next" aria-labelledby="partner-next-title"><div><p className="ritual-label">What comes next</p><h2 id="partner-next-title">Two platforms. More to explore.</h2></div><div><p>We’re getting ready to partner with Degen Arena and introduce our communities to each other. This is your first look at who they are.</p><p>We’ll share the details of what we’re doing together here as they’re confirmed.</p><a href={site} target="_blank" rel="noopener noreferrer">Get to know Degen Arena <ArrowUpRight size={18} /></a></div></section>
    <p className="partner-fine-print">Degen Arena is a separate platform with its own rules and terms. Games involve financial risk. Read the rules and play responsibly.</p>
  </div>;
}
