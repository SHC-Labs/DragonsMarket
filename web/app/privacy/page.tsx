import type { Metadata } from "next";
import Link from "next/link";
import { LegalDocument, type LegalSection } from "@/components/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy | Dragons Market",
  description: "How Dragons Market handles wallet information, local preferences, public blockchain records and privacy choices.",
  robots: { index: false, follow: true },
};

const sections: LegalSection[] = [
  {
    id: "information-we-use",
    title: "Information we receive",
    content: <>
      <p>You can read public markets without connecting a wallet. Connecting one lets the site use your public address to show account-related information.</p>
      <ul>
      <li><strong>Wallet and market records.</strong> The site reads public balances, positions, transactions, market results and Council records. These can include addresses, submitted evidence, votes and explanations.</li>
      <li><strong>Saved choices.</strong> Your browser stores your theme, saved markets and policy acknowledgement. The acknowledgement includes the wallet address, network, document versions and a timestamp from your device.</li>
      <li><strong>Connection details.</strong> Hosts and network providers receive requests needed to load pages and retrieve records. Requests can reveal your IP address, browser headers and the account or contract being queried. Providers may retain security and operational logs.</li>
      <li><strong>Messages and submissions.</strong> We receive information you choose to send us, such as a question or supporting evidence.</li>
      </ul>
      <p>The website does not currently ask for identity documents, payment-card details or access to your precise location. Your wallet manages its own credentials. Never send us a private key or recovery phrase.</p>
    </>,
  },
  {
    id: "purposes-and-legal-bases",
    title: "How we use information",
    content: <>
      <p>We use information to display markets and account activity, remember your choices, answer requests and keep the service working. We may also use relevant records to investigate abuse, meet legal duties or handle a legal claim.</p>
      <p>Where data-protection law requires a legal basis, we rely on the basis that fits the purpose:</p>
      <ul>
      <li><strong>Providing a requested service.</strong> Information needed to perform an agreement with you.</li>
      <li><strong>Legitimate interests.</strong> Keeping the service secure and investigating problems, balanced against your privacy rights.</li>
      <li><strong>Legal duties.</strong> Processing required by a law that applies to us.</li>
      <li><strong>Consent.</strong> Optional processing for which the law requires your permission.</li>
      </ul>
      <p>Agreeing to the Terms does not give us permission to use your information for unrelated purposes. We do not treat case submissions as permission for unrelated advertising, profiling or AI training.</p>
    </>,
  },
  {
    id: "storage-and-tracking",
    title: "What stays in your browser",
    content: <>
      <p>Your saved markets, theme and policy acknowledgement stay in that browser. They do not currently sync through a Dragons Market account database. The acknowledgement is a local record, not a wallet signature.</p>
      <p>Clear this site’s data in your browser to remove those records. Your saved markets and theme will reset, and you will be asked to review the policies again. Disconnecting a wallet does not clear them.</p>
      <p>The website currently has no advertising pixels or third-party audience analytics. Wallets and linked services may use their own cookies or storage. We will explain new tracking before introducing it and ask permission where required.</p>
    </>,
  },
  {
    id: "sharing-and-providers",
    title: "Who receives information",
    content: <>
      <p>Hosting services deliver the website. Blockchain data providers answer queries about markets, accounts and transactions. Wallet providers handle connections and any requests you approve. Each receives the information needed for its part of the service.</p>
      <p>We may share relevant information to meet a legal duty, investigate fraud, protect people or handle a legal claim. If the service changes ownership, relevant records may transfer with it, subject to applicable privacy obligations.</p>
      <p>We do not sell personal information or share it for targeted advertising. Listing a partner does not give that partner your watchlist. When you follow an external link, that service’s own privacy policy applies.</p>
    </>,
  },
  {
    id: "public-blockchain-records",
    title: "What becomes public",
    content: <>
      <p>Wallet addresses, transactions, positions and published Council activity can be public. Others may connect these records with information that identifies you. A wallet address does not guarantee anonymity.</p>
      <p>Independent networks, explorers and other people can copy blockchain records. We cannot erase their copies. Removing information from our website does not remove it from those systems.</p>
      <p>Only submit evidence you have the right to publish. Leave out unnecessary identity details, private messages and information about other people, especially children. Trades or votes can invite sensitive inferences, but do not necessarily reflect a person’s beliefs.</p>
      <p>These technical limits do not remove your rights over information we control. We remain responsible for how we collect, display and otherwise use that information.</p>
    </>,
  },
  {
    id: "retention-and-security",
    title: "Retention and security",
    content: <>
      <p>We keep information under our control for the purpose it was collected. How long we need it depends on the request, security issue, dispute or legal duty involved. We delete or anonymise it when it is no longer needed, unless a legal preservation duty applies.</p>
      <p>A legal claim can require us to keep relevant records longer. That does not permit us to keep everything indefinitely or reuse it for unrelated purposes. Independent providers and public networks control their own records.</p>
      <p>No online service can guarantee complete security. Protect your wallet and device, check permissions before approving them, and keep recovery details private. Disconnecting from this site does not revoke permissions inside your wallet.</p>
      <p>If information we control is affected by a security incident, we will investigate and take the protective steps required by law. We will notify affected people and authorities where the law requires it.</p>
    </>,
  },
  {
    id: "international-processing",
    title: "Information processed in other countries",
    content: <>
      <p>Our hosts and the wallet or network services you use may process information outside your country. Local privacy laws can differ. Public blockchains also distribute records across countries.</p>
      <p>When we transfer personal information, applicable data-protection law still applies. Where required, we must use an approved transfer mechanism or another lawful basis. Accepting these policies does not waive those requirements.</p>
    </>,
  },
  {
    id: "privacy-rights",
    title: "Your choices and privacy rights",
    content: <>
      <p>You can browse public markets without a wallet, disconnect a connected wallet and clear locally saved site data.</p>
      <p>Depending on the law that applies, you may ask to access, correct, copy or delete personal information we hold. You may also have rights to restrict or object to a use, withdraw consent, or appeal a decision about your request.</p>
      <p>We may need enough information to confirm a request is yours. Legal exceptions and response deadlines depend on the applicable law. Withdrawing consent does not undo earlier lawful processing.</p>
      <p>You may complain to the privacy regulator available to you. Exercising a privacy right will not result in unlawful discrimination. Independent blockchain records may be impossible for us to change. That does not excuse our duties over information we control.</p>
      <p>A public privacy-request contact is not yet available. We will publish it here before public launch. Never include a private key or recovery phrase in a request.</p>
    </>,
  },
  {
    id: "age-and-updates",
    title: "Age requirements",
    content: <>
      <p>You must be at least 18, or meet any higher local age requirement, to participate. The <Link href="/terms#eligibility">Terms of Use</Link> explain eligibility.</p>
      <p>We do not currently verify your age through a wallet connection. Accepting our Terms records your agreement; it does not prove your age or identity.</p>
      <p>We do not knowingly seek personal information from children. If we learn that a child has provided information we control, we will review it and delete it where required by law. We cannot erase independent blockchain records.</p>
    </>,
  },
  {
    id: "policy-updates",
    title: "Changes to this policy",
    content: <>
      <p>We update this policy when our information practices or legal requirements change. The date above shows when this policy was last updated. We keep previous versions available.</p>
      <p>We will give notice of material changes before they take effect where required. A new policy acknowledgement does not replace any separate consent the law requires.</p>
    </>,
  },
];

export default function PrivacyPage() {
  return <LegalDocument title="Privacy Policy" related={{ href: "/terms", label: "Terms of Use" }} sections={sections} intro={
    <p>This policy explains what information Dragons Market uses and what you can control. Some choices stay in your browser. Blockchain activity may be public and permanent. Independent wallets and other services have their own privacy policies.</p>
  } />;
}
