import { CollectionGallery } from "./CollectionGallery";
import Image from "next/image";
import { ArrowDown, Coin, Judge, Lock } from "./icons";
import { Embers } from "./Embers";

const WALL = ["robots-01", "council-02", "robots-03", "council-03", "robots-05", "council-01", "robots-02", "council-04", "robots-04", "robots-06"];

const TERMS = [
  { title: "Help resolve disputes", icon: Judge, text: "When drawn, read the market rule and evidence, commit your vote, then reveal it before the deadline. Your vote and reason become part of the public case record." },
  { title: "Share in platform fees", icon: Coin, text: "The Council allocation is 25% of collected platform fees, shared among eligible staked seats. Earnings depend on fees and time staked; there is no fixed payout. Quarterly payouts are planned, with claim terms published before launch." },
  { title: "Stake with a commitment", icon: Lock, text: "Only staked NFTs earn and can be drawn. A seat serving on a case cannot leave until it is released. Unstaking also has a cooldown, so check the published terms before joining." },
];

export function Membership() {
  return (
    <section id="membership" className="council-membership" aria-labelledby="membership-title">
      <div className="council-membership-intro">
        <Embers height={0.7} intensity={0.9} spark="--council" smoke="--council" />
        <div className="council-wall" aria-hidden="true">{[0, 1, 2].map(col => <div key={col} className="council-wall-col">{WALL.filter((_, i) => i % 3 === col).concat(WALL.filter((_, i) => i % 3 === col)).map((name, i) => <Image key={`${name}-${i}`} src={`/collection/${name}.jpg`} alt="" width={360} height={360} unoptimized />)}</div>)}</div>
        <div className="council-hero-copy">
          <p className="eyebrow council-eyebrow"><span className="brand-mark" aria-hidden="true" />Dragon Council</p>
          <h2 id="membership-title">Join the Council</h2>
          <p>Stake a Dragon NFT to join the Council. Staked seats can be drawn for dispute juries and earn a share of platform fees. Holding an unstaked NFT does not make you eligible for either.</p>
          <a href="#process" className="ritual-link">See how disputes work <ArrowDown size={16} /></a>
        </div>
        <aside className="membership-overview" aria-labelledby="membership-launch-title">
          <div className="membership-pass-head"><span className="brand-mark" aria-hidden="true" /><span className="eyebrow">Council seat</span></div>
          <h3 id="membership-launch-title">Before you join</h3>
          <dl>
            <div><dt>Mint</dt><dd>Not open yet</dd></div>
            <div><dt>Council access</dt><dd>Stake a Dragon NFT</dd></div>
            <div><dt>Fee distributions</dt><dd>Quarterly planned</dd></div>
          </dl>
          <p>Supply, price, launch date and final participation terms will be published before the mint opens.</p>
        </aside>
      </div>
      <div id="collection"><CollectionGallery /></div>
      <div className="membership-terms">
        <div className="terms-heading"><h2>Membership terms</h2></div>
        <div className="terms-list">
          {TERMS.map(({ title, icon: Icon, text }) => <article key={title}><span className="terms-icon" aria-hidden="true"><Icon size={24} variant="Bulk" /></span><div><h3>{title}</h3><p>{text}</p></div></article>)}
        </div>
      </div>
    </section>
  );
}
