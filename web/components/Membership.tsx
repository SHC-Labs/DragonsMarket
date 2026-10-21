import { CollectionGallery } from "./CollectionGallery";

export function Membership() {
  return (
    <section id="membership" className="council-membership" aria-labelledby="membership-title">
      <div className="council-membership-intro">
        <div>
          <h2 id="membership-title">Join the Council</h2>
          <p>Stake a Dragon NFT to take a Council seat. Eligible staked seats earn a share of platform fees and can be drawn to review disputes. An unstaked Dragon is not eligible for either.</p>
          <a href="#process" className="ritual-link">See how disputes work ↘</a>
        </div>
        <aside className="membership-overview" aria-labelledby="membership-launch-title">
          <h3 id="membership-launch-title">Before you join</h3>
          <dl>
            <div><dt>Mint</dt><dd>Not open yet</dd></div>
            <div><dt>Council access</dt><dd>Stake a Dragon NFT</dd></div>
            <div><dt>Fee distributions</dt><dd>Quarterly, planned</dd></div>
          </dl>
          <p>Supply, price, launch date and final participation terms will be published before the mint opens.</p>
        </aside>
      </div>
      <div id="collection"><CollectionGallery /></div>
      <div className="membership-terms">
        <div className="terms-heading"><h2>Membership terms</h2></div>
        <div className="terms-list">
          {[
            ["Help resolve disputes", "If you are drawn for a case, read the market rule and evidence. Commit your vote, then reveal it before the deadline. Your vote and reason go into the public case record."],
            ["Share in platform fees", "The Council receives 25% of collected platform fees, shared among eligible staked seats. Your share depends on fees collected and time staked, so payouts vary. We plan quarterly payouts and will publish claim terms before launch."],
            ["Before you stake", "Only staked NFTs earn fees and can be drawn for a jury. A seat assigned to a case stays locked until it is released. A cooldown also applies when unstaking; check the published terms before joining."],
          ].map(([title, text]) => <article key={title}><div><h3>{title}</h3><p>{text}</p></div></article>)}
        </div>
      </div>
    </section>
  );
}
