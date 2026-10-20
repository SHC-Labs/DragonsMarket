# Dragons Market legal protection review

Reviewed 19 October 2026 against the downloaded General Legal templates, the current frontend and the accepted Intents custody plan. This is a working risk review and revised drafting, not a jurisdiction-specific legal opinion or confirmation that launch is permitted. No backend, contract, deployment or real-money action was changed or authorised. The backend remains deferred while the contract work continues.

## What the website now covers more clearly

The revised Terms and Privacy Policy are version **2026-10-19.3**. The previous **2026-10-19.1** and **2026-10-19.2** documents remain unchanged. Public standalone copies and SHA-256 file hashes are under `public/legal/`. Current document pages link to their preserved copy. These copies establish which text was saved; they do not retrospectively authenticate browser acceptance records or create trusted timestamps.

## Full plain-language rewrite

Every section was reread and rewritten after the owner identified internal compliance language in the public Privacy Policy. The reading target is a general-public grade 6 to 8 level; no formal reading-grade score is claimed. Shorter sentences, direct statements and descriptive headings replace template instructions. The introductions provide a plain-language overview alongside the full terms. Age requirements and policy updates now have separate sections, with the old age anchor preserved.

| Earlier wording or pattern | Issue | Revised public wording |
| --- | --- | --- |
| “Personal information received from a child must be handled in accordance with applicable deletion and protection requirements.” | Tells an internal compliance team what to do, without explaining the policy to the visitor. | “If we learn that a child has provided information we control, we will review it and delete it where required by law.” |
| “It is not directed to children.” | Does not distinguish an age restriction from actual age verification. | “We do not currently verify your age through a wallet connection.” |
| “Age limits and policy updates” | Combines unrelated topics and hides the age limitation. | Separate “Age requirements” and “Changes to this policy” sections. |

The rewrite retains the existing scope of protections and mandatory-rights exceptions. It does not enable financial actions, add verification, invent an operator or contact, or turn local policy acknowledgement into signed evidence. Privacy statements still need to be checked against the actual production provider and data inventory before launch. Age-assurance terminology was checked against [ICO guidance](https://ico.org.uk/about-the-ico/what-we-do/information-commissions-opinions/age-assurance-for-the-children-s-code/1-age-assurance/); that regional guidance does not establish worldwide requirements.

| Exposure | Drafting change | Remaining limit |
| --- | --- | --- |
| A visitor merely saw a link | Terms distinguish explicit wallet acceptance from a page being displayed. | Current acceptance is unsigned browser storage. Durable evidence is deferred. |
| Conflicting marketing, general terms and market rules | Specific pre-action terms address their own subject; mandatory law takes priority. Later promotional or website copy does not automatically rewrite a position. | Final market rulebook must match the contracts and transaction UI. |
| A UI error or pending operation is treated as a refund entitlement or a fresh payment | Clarifies transaction status, duplicate-operation risk, unsupported transfers and limits of recovery. | No unilateral cancellation, confiscation or retrospective payout power was invented. Actual recovery procedures must exist. |
| A policy click is treated as financial authorisation | Policy acceptance is separate from trading, withdrawal and permission delegation. | Future signing must preserve this separation in the actual message and verification path. |
| Manipulation, conflicts and misleading evidence | Adds juror conflict disclosure, evidence rights/provenance and limits on unauthorised representation. | Recusal, reporting, sanctions and case deadlines still need operational rules consistent with the final ABI. |
| An NFT is mistaken for platform ownership, copyright or guaranteed income | Retains conditional eligibility/fee terms and adds clearer authority and participation boundaries. | A separate mint agreement, artwork licence and regulatory classification review remain necessary. |
| Third-party claims caused by a user's deliberate abuse | Adds a narrow responsibility clause for fraud, deliberate unlawful use and knowing infringement, limited by causation and applicable law. | No unlimited indemnity, automatic legal bill or indemnity for the platform's own fault. Enforceability remains jurisdiction-specific. |
| Outages, termination and unresolved positions | Explains continuity of existing obligations and reasonable disruption mitigation. | No absolute uptime promise, automatic asset forfeiture or indefinite withdrawal freeze. |
| A complaint is confused with a market challenge | Separates legal complaints from case deadlines and explains what records are relevant. | Contact details and a real process are still absent; no invented support channel or compulsory waiting period. |
| Public evidence exposes other people | Adds minimisation, sensitive-inference caution and limits on reusing case material. | Technical immutability is not a blanket exemption from obligations over controlled data. |
| Deletion requests conflict with genuine record preservation | Clarifies purpose-limited retention and legal holds rather than indefinite retention of everything. | Production retention schedule, incident process and provider inventory remain unverified. |

## The highest-priority gaps that wording does not close

### 1. Access and product classification

**Open, before public financial activity.** Select the intended countries and assess the actual prediction-market model, NFT rights, token flows and marketing in each. A user's declaration, an offshore location, wallet-only access or an acceptance checkbox does not establish permission to operate.

As a concrete regional example, the UK Gambling Commission says the prediction-market models it describes would generally fall within its betting-intermediary framework and tells unlicensed operators not to target or transact with consumers in Great Britain. That is a regional warning, not a finding that Dragons Market has been classified everywhere. [Gambling Commission, 4 February 2026](https://www.gamblingcommission.gov.uk/blog/post/prediction-markets-heres-what-you-need-to-know)

Our NFT review priority is an inference from the proposed economic rights: holders may participate in platform-fee allocations. ESMA's classification guidance assesses rights and characteristics rather than technological labels. Calling a token an NFT or stating that returns are not guaranteed does not itself settle its status. This review does **not** conclude that our NFTs are securities. [ESMA classification guidelines](https://www.esma.europa.eu/sites/default/files/2025-03/ESMA75453128700-1323_Guidelines_on_the_conditions_and_criteria_for_the_qualification_of_CAs_as_FIs.pdf)

Required outcome: counsel-approved access/product matrix, marketing scope and the controls actually required by that matrix. Do not publish an invented list of excluded countries or claim geoblocking, age verification, sanctions checks or licences are implemented.

### 2. Operator identity, contact and legal responsibility

**Open.** The owner explicitly requested brand-only wording, so no entity, country, address or contact was invented. That preference does not establish an anonymous liability shield or satisfy required disclosures. For example, UK GDPR transparency guidance calls for the organisation's identity and contact details; its current page is flagged for review following legislative changes. Determine the exact requirements in the actual launch jurisdictions. [ICO privacy information guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-privacy-information-should-we-provide/)

Required outcome: identify the contracting party and controller, a working public privacy/legal contact, applicable representatives where needed, and a counsel-reviewed forum/law strategy. Do not assume omitting an entity protects the people operating the service. No entity or structural arrangement was selected by this review.

### 3. Evidence of acceptance

**Deferred with backend work.** Keep policy versions immutable and preserve a verifiable receipt of the explicit action. Current local storage can be changed or deleted and has a client-generated timestamp. It cannot be presented as a server audit log or verified wallet signature.

The future backend decision should cover challenge issuance/expiry, signature and account-key verification, single-use nonces, origin/network binding, exact document hashes, server time, retention and proof export. No new backend work was started. A receipt records an acceptance action; it cannot establish actual reading, age, capacity or blanket regulatory compliance.

### 4. Custody, settlement and exits

**Open, contract-owner work.** The accepted target is controlled market backing inside Intents. The final authority and permission model is still being built. Do not describe it as noncustodial solely because it uses Intents or suggest the backend alone can lock spendable collateral.

Required outcome: reconcile the actual control model, recovery paths, supported assets, fees, finality and user exit rights with the rulebook and legal disclosures. Website terms cannot repair a double-credit bug, missing custody authority, replayable confirmation or undefined recovery flow. No contract code or API was changed.

### 5. Liability limits and disputes

**Partially addressed in drafting; legal decision remains.** Kept mandatory-rights exceptions and limited the new third-party-claim clause by fault and causation. Did not import the template's US arbitration administrators, class/jury waivers, California venue, arbitrary USD cap, blanket release or unrestricted right to terminate/change anything. The CMA warns that unfair or opaque terms may not be usable and can expose a business to enforcement. This is one regional enforceability reference, not a global court opinion. [CMA fair-contract guidance](https://www.gov.uk/guidance/writing-a-fair-contract-for-customers)

Required outcome: assess a defensible liability allocation and any cap against the actual operator, insurance, customer types, services and target law. There is no invented worldwide cap in the draft. Council adjudication remains market settlement rather than compulsory arbitration of all legal claims.

## Other agreements and controls to prepare before they become relevant

| Area | Useful downloaded starting point | What still needs tailoring |
| --- | --- | --- |
| Infrastructure and data vendors | Global DPA and MSA | Correct controller/processor roles, actual subprocessors, processing instructions, security duties, incident notification, deletion and any applicable transfer mechanism. A public privacy page is not a signed vendor DPA. |
| Artwork, commissioned work and software | MSA, NDA and relevant advisor agreement | Ownership/licence chain, contributor permissions, third-party rights, confidentiality and use of project branding. No rights were inferred from possession of an image. |
| NFT mint and holder rights | Current Terms are only an umbrella | Collection-specific price/supply, eligibility, exact benefits, artwork licence, staking limits, transfer effects, refunds/cancellation where applicable and whether any feature can change. |
| Jurors and market creators | Current Terms and final Council/market rules | Conflict handling, evidence standards, deadlines, penalties, complaints and a usable reporting route. Do not promise contractual protections the technology does not implement. |
| Partnerships and promotions | MSA/NDA can inform negotiation | Brand permissions, scope, responsibility, permitted claims and any referral data flows. The coming-soon partnership page does not prove an executed commercial agreement. |
| Cookies and optional tracking | Cookie Notice template | Inventory actual first- and third-party storage and lawful consent/choice requirements. Do not claim every storage item is exempt, or add a fictitious advertising-consent tool. |
| Incident response and records | Privacy/DPA templates inform obligations | Actual access controls, retention/deletion schedule, legal-hold process, provider investigation and any required regulator/user notification. |

US employee offer letters and the healthcare BAA are not substitutes for these product-specific agreements. Confidentiality documents cannot make already public blockchain records private.

## Required consistency checks for the next release

- Compare marketing statements, mint benefits, fee allocations and payout timing with the approved rulebook and actual product. Disclaimers do not erase contradictory promises.
- Do not add a statement that NFTs are unregulated, that all risk is the user's, that wallet connection proves adulthood, that “code is law” defeats legal claims, or that decentralisation removes platform responsibility.
- Complete the public legal/privacy request channel before representing requests as operational. The drafts currently disclose that the contact is pending.
- Review purpose, recipient and transfer disclosures against production behaviour, including any new backend records or AI processing. The current privacy additions are obligations and limits to implement, not evidence that a production programme has been audited.
- Keep the policy version constants, published copy and acceptance prompt aligned. A future change to one policy must invalidate acceptance of that policy's former version.
- Keep immutable older versions and the original licence/source information. A SHA-256 manifest checks file integrity; it is not a notarisation, proof of a user's acceptance or a trusted publication timestamp.

**Outcome:** the draft now closes identifiable wording gaps. Legal identity, market access, NFT classification, custody rules, operational privacy controls and durable acceptance evidence remain unresolved. A public financial launch is not approved by this review.
