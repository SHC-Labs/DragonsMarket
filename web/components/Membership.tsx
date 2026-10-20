import { CollectionGallery } from "./CollectionGallery";

export function Membership() {
  return (
    <section id="membership" className="council-membership" aria-labelledby="membership-title">
      <div className="council-membership-intro">
        <div>
          <h2 id="membership-title">Join the Council</h2>
          <p>Stake a Dragon NFT to join the Council. Staked seats can be drawn for dispute juries and earn a share of platform fees. Holding an unstaked NFT does not make you eligible for either.</p>
          <a href="#process" className="ritual-link">See how disputes work ↘</a>
        </div>
        <aside className="membership-overview" aria-labelledby="membership-launch-title">
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
          {[
            ["Help resolve disputes", "When drawn, read the market rule and evidence, commit your vote, then reveal it before the deadline. Your vote and reason become part of the public case record."],
            ["Share in platform fees", "The Council allocation is 25% of collected platform fees, shared among eligible staked seats. Earnings depend on fees and time staked; there is no fixed payout. Quarterly payouts are planned, with claim terms published before launch."],
            ["Stake with a commitment", "Only staked NFTs earn and can be drawn. A seat serving on a case cannot leave until it is released. Unstaking also has a cooldown, so check the published terms before joining."],
          ].map(([title, text]) => <article key={title}><div><h3>{title}</h3><p>{text}</p></div></article>)}
        </div>
      </div>
    </section>
  );
}
