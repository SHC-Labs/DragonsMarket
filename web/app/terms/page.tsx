import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocument, type LegalSection } from "@/components/LegalDocument";

export const metadata: Metadata = {
  title: "Terms of Use | Dragons Market",
  description: "Conditions for using Dragons Market, including market rules, wallet security, Council participation, risks and local legal requirements.",
  robots: { index: false, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "eligibility",
    title: "Who can participate",
    content: <>
      <p>You must be at least 18 and meet any higher age requirement where you live or use the service. You must be legally able to agree to these Terms. If you act for another person or organisation, you need their authority.</p>
      <p>A wallet connection does not tell us your age, identity or location. Accepting these Terms does not verify those details.</p>
      <p>Use a feature only where it is lawful for you. Do not bypass restrictions on eligibility, location, sanctions or access. A website being reachable does not mean its services are permitted everywhere.</p>
      <p>Your obligations do not replace our own legal duties.</p>
    </>,
  },
  {
    id: "service-and-availability",
    title: "Using the service",
    content: <>
      <p>Dragons Market displays prediction markets, account activity and public settlement records. It also describes Dragon NFTs and Council membership.</p>
      <p>You can use a feature only when it is enabled and supported. Announcing trading, deposits, minting, staking or fee distributions does not make them available. Do not send funds based only on a roadmap or announcement.</p>
      <p>These Terms cover general site use. A market, NFT release or funding route may have additional terms shown before you participate. Those specific terms govern their own subject. Applicable law takes priority.</p>
      <p>Later marketing or website edits do not automatically change an existing position’s rules. Nothing here guarantees access, liquidity or future earnings.</p>
    </>,
  },
  {
    id: "wallet-security",
    title: "Your wallet and permissions",
    content: <>
      <p>Connect only a wallet you are authorised to use. Keep your device, wallet and recovery details secure. We do not need your private key or recovery phrase.</p>
      <p>Before using wallet features, you must agree to the Terms and acknowledge the Privacy Policy. We remember that choice for the wallet and network in your browser. Clearing site data or changing policy versions can trigger another review.</p>
      <p>Acknowledging a policy does not authorise a trade, withdrawal or wallet permission. Review each request separately, including the network, recipient, amount and fees. Disconnecting the site does not revoke permissions already granted in your wallet.</p>
      <p>Displayed balances and statuses can be delayed or incomplete. Check the relevant transaction record before sending again.</p>
    </>,
  },
  {
    id: "market-rules",
    title: "Markets, results and payouts",
    content: <>
      <p>Read the market question, outcomes, closing time, result source, fees and cancellation rules before taking a position. If something conflicts or is unclear, do not proceed until it is clarified.</p>
      <p>Prices show how the market prices an outcome. They do not prove an event will happen. Charts and other records may be delayed or contain errors.</p>
      <p>The published market rules and contract procedures determine settlement. Proposals, challenges and jury reviews have deadlines. Evidence, votes and reasons for a decision may be public.</p>
      <p>Winning, losing and cancelled positions can pay differently. A cancellation does not necessarily refund your purchase or split the payout equally. Network fees may still apply. Recorded actions may be irreversible.</p>
      <p>Correcting a display error does not give us an unrestricted right to cancel a position or change its payout. A network record shows what happened technically; it does not prove an action was authorised or lawful.</p>
      <p>The Council decides market outcomes under the platform’s rules. Its process does not remove your right to seek a legal remedy.</p>
    </>,
  },
  {
    id: "funding-and-transfers",
    title: "Deposits, transfers and withdrawals",
    content: <>
      <p>When funding or withdrawals are available, use only the assets, networks and routes shown in that flow. Check the address, memo, minimum amount, fees and any quote expiry before approving.</p>
      <p>An unsupported asset or incorrect destination can cause permanent loss. Cross-chain transfers can involve several providers, fees and confirmation steps. Tokens held in another wallet or protocol are not automatically available to trade here.</p>
      <p>Rates, liquidity and provider availability can change. Review the terms shown for the action before approval. A pending status or timeout does not prove failure. Check the operation reference before repeating it.</p>
      <p>We cannot guarantee recovery of a mistaken transfer. If recovery is available, we will explain the process and any costs before asking you to approve it. These Terms do not permit undisclosed charges or remove a remedy required by law.</p>
    </>,
  },
  {
    id: "council-and-nfts",
    title: "Dragon NFTs and the Council",
    content: <>
      <p>Owning a Dragon NFT does not automatically activate a Council seat or qualify you for every distribution. The published rules define minting, staking, jury selection, unstaking and any fee allocation.</p>
      <p>Before joining, check any bond, lock, cooldown and participation deadline. Jurors must assess evidence honestly, disclose material conflicts and follow the case rules. Bribery, collusion and market manipulation are prohibited.</p>
      <p>Any quarterly payout depends on eligible participation, collected fees and the published distribution terms. There is no guaranteed return, resale price or payment amount.</p>
      <p>An NFT does not by itself give you ownership of Dragons Market or copyright in its artwork. Any artwork licence is separate. Holding an NFT does not authorise you to make commitments on our behalf.</p>
      <p>Any penalty affecting a stake or reward must follow the rules disclosed for that participation. We do not gain additional confiscation powers through these Terms.</p>
    </>,
  },
  {
    id: "risk",
    title: "Financial and technical risks",
    content: <>
      <p>A losing position can lose its entire purchase amount. Tokens can lose value or their peg, become illiquid or stop working with a provider. Networks, contracts, wallets and other software can fail or be compromised.</p>
      <p>Use only money you can afford to lose. Do not borrow to participate or rely on a possible payout for living expenses.</p>
      <p>The site does not provide personalised investment, legal or tax advice. It does not guarantee a profit or indicate regulatory approval. Do not assume assets or positions carry bank-deposit insurance or investor compensation protection.</p>
    </>,
  },
  {
    id: "acceptable-use",
    title: "Conduct we prohibit",
    content: <>
      <ul>
      <li>Fraud, money laundering, sanctions evasion or using assets without authority.</li>
      <li>Manipulating markets, falsifying evidence, bribing jurors or colluding over a result.</li>
      <li>Exploiting vulnerabilities, disrupting infrastructure or bypassing security controls and rate limits.</li>
      <li>Impersonating the project, a partner, support staff or another user.</li>
      <li>Publishing unlawful content, exposing private information or infringing another person’s rights.</li>
      </ul>
      <p>Separate open-source licences and legal exceptions still apply. These Terms do not prohibit lawful security research that avoids harm and unauthorised access.</p>
    </>,
  },
  {
    id: "taxes-compliance",
    title: "Taxes and records",
    content: <>
      <p>You are responsible for the taxes, reporting and records that apply to your activity. That can include trades, transfers, NFTs, staking, fee distributions and gains or losses. The site’s display is not a tax statement.</p>
      <p>We may need to apply verification, restrictions, reporting or withholding required by law. Using a wallet or a decentralised network does not remove legal obligations for either of us.</p>
    </>,
  },
  {
    id: "third-parties-and-content",
    title: "Other services and content rights",
    content: <>
      <p>Wallets, networks, data providers and partner sites have their own terms, fees and privacy practices. A partnership or link does not guarantee their safety, availability or results.</p>
      <p>Branding, artwork and original content belong to their respective rights holders. These Terms grant no permission to impersonate the project or reuse protected material beyond a licence or legal exception.</p>
      <p>You retain your rights in material you submit. You give us permission to reproduce, display, format, retain and share it as needed for the relevant market or case. This permission does not cover unrelated uses.</p>
      <p>Submit only material you may lawfully share. It must be accurate to the best of your knowledge and attributed where required. Do not publish confidential information or unnecessary personal details. We may restrict unlawful or abusive content on the website and keep relevant records for a dispute or legal duty.</p>
      <p>We cannot erase copies held by independent public networks. A name, logo or community role alone does not authorise someone to make promises on our behalf. We remain responsible for commitments we authorise.</p>
    </>,
  },
  {
    id: "third-party-claims",
    title: "Claims arising from deliberate abuse",
    content: <>
      <p>Your fraud or deliberate unlawful use may cause someone else to bring a claim against us. Where the law allows, you may be responsible for the reasonable direct losses it causes. This also covers material you knowingly submit in breach of another person’s rights.</p>
      <p>Any claim against you must reflect your responsibility and be supported by evidence. It does not cover ordinary lawful use or losses caused by our own breach, negligence or misconduct.</p>
      <p>We will give you reasonable notice and an opportunity to respond. We cannot make you pay for a voluntary settlement without your agreement.</p>
    </>,
  },
  {
    id: "availability-and-responsibility",
    title: "Availability and limits on responsibility",
    content: <>
      <p>We provide the service as available. We cannot guarantee uninterrupted access, accurate information at every moment or the performance of independent providers. We will take reasonable steps to reduce disruption within our control.</p>
      <p>Where the law allows, we exclude implied warranties and liability for indirect or unforeseeable losses, including lost expected profits.</p>
      <p>We do not exclude liability for fraud, deliberate misconduct, or death or personal injury caused by negligence. We also do not exclude any liability, consumer guarantee or remedy that the law does not let us exclude.</p>
      <p>A risk warning or outage does not excuse our own legal duties. It does not give us an automatic right to retain assets or rewrite settlement rules.</p>
    </>,
  },
  {
    id: "restrictions-and-changes",
    title: "Restrictions, leaving and policy changes",
    content: <>
      <p>We may restrict a feature to address a security incident, suspected abuse, a legal requirement or a material breach of these Terms. Where reasonably possible, we will explain the reason and available next steps.</p>
      <p>Restricting website access does not itself confiscate independently held assets or change recorded contract rights. Disconnecting your wallet does not close a position, unlock a stake or erase public records. Existing positions, Council duties and lawful claims remain subject to their applicable rules.</p>
      <p>We may change features and these Terms as the service develops. We will give notice of material changes and obtain fresh agreement where required. The date above shows when these Terms were last updated; preserved copies remain available.</p>
      <p>A later policy update does not automatically rewrite settlement rules for an existing position.</p>
    </>,
  },
  {
    id: "questions-and-complaints",
    title: "Questions and complaints",
    content: <>
      <p>Keep the market rules, policy version and relevant transaction references for your activity. When raising a complaint, explain what happened and the outcome you seek. Do not include private keys, recovery phrases or unnecessary identity documents.</p>
      <p>A website complaint is separate from a market challenge. Raising a complaint does not extend a challenge deadline unless the rules or law say otherwise.</p>
      <p>A public support and legal-notice contact is not yet available. We will publish it here before launch. You do not need to complete an unavailable internal process before contacting a regulator or exercising a legal remedy.</p>
    </>,
  },
  {
    id: "privacy-and-legal-rights",
    title: "Your privacy and legal rights",
    content: <>
      <p>The <Link href="/privacy">Privacy Policy</Link> explains how information is used. Acknowledging it does not give permission for unrelated optional processing.</p>
      <p>Applicable law determines which laws and courts govern a legal claim. These Terms do not take away protections you cannot lawfully waive, including applicable protections where you live.</p>
      <p>We do not require private arbitration or a class-action waiver through these Terms. If a provision cannot be enforced, the remaining provisions continue to apply where lawful. Not enforcing a provision once does not give up the right to enforce it later.</p>
    </>,
  },
];

export default function TermsPage() {
  return <LegalDocument title="Terms of Use" related={{ href: "/privacy", label: "Privacy Policy" }} sections={sections} intro={
    <>
      <p>These Terms explain the conditions for using Dragons Market. Read them before using wallet features. If you do not agree, do not use those features.</p>
      <p>Participation involves financial risk. Your agreement does not verify your age, authorise payments or take away rights the law does not let you waive.</p>
    </>
  } />;
}
