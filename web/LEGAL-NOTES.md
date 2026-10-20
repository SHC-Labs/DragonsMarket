# Legal page adaptation notes

19 October 2026. Working legal copy for owner and qualified legal review. This is not a legal-compliance sign-off. The routes deliberately use `noindex` while launch details remain unresolved. They are available in the local site and footer; no production deployment was performed.

## Sources and scope

- Adapted the locally downloaded General Legal CC0 templates at `~/Nameless/legal-templates/templates/privacy-policy-gdpr/template.md` and `~/Nameless/legal-templates/templates/terms-of-use/template.md`. The GDPR-enhanced source already covers multiple regions. Template licence: `~/Nameless/legal-templates/LICENSE` (CC0 1.0). The small source credit is retained on the pages.
- Read Degen Arena’s https://degenarena.gg/privacy-policy and https://degenarena.gg/terms-of-service as coverage references at the owner's request. Did not copy their layout or text. Wallet data, public chain records, transaction risks and taxes are relevant topics; Degen Arena's passkey data, internal wallet, cookies, games, referrals, provider inventory, fixed liability cap and support contact are not represented as Dragons Market features or terms.
- Checked current primary guidance on rights and transfers: https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en and https://www.edpb.europa.eu/sme/be-compliant/international-data-transfers_en. Consumer-term fairness reference: https://www.gov.uk/guidance/writing-a-fair-contract-for-customers.
- Removed assumed US domicile, California/New York court clauses, US arbitration administrators, jury/class waivers, US-only export wording, state-by-state notices and the arbitrary USD liability cap. Mandatory local rights remain applicable. No jurisdiction was invented.
- Operator identity, registration and address are omitted at the owner's explicit request. The omission is not a conclusion that these disclosures are optional under applicable law.

## Copy checked against the current frontend

- `lib/watchlist.ts` stores saved market IDs in local storage, keyed by network, market contract and connected account. There is no cross-device watchlist service.
- `components/ThemeToggle.tsx` stores the display preference locally.
- `components/WalletProvider.tsx` uses NEAR Connect when a wallet-enabled network is configured. Wallets manage secrets and sign requests. No password registration, passkey account flow, card form or identity-document form was found in this frontend.
- `lib/rpc.ts` queries the configured RPC service. Requests and public account lookups may expose connection/query information to providers. Do not promise that a public account identifier is anonymous.
- No advertising pixel or audience analytics integration was found in app/components/lib. That does not independently establish the logging practices of every hosting or wallet provider.
- Trades, deposits, Intents, minting, staking, voting and distributions remain described conditionally. This work did not enable or connect contract writes.
- Council settlement is distinct from legal arbitration. A website suspension is not described as confiscation of independent wallet assets or a rewrite of existing settlement rules.

## Unresolved before public launch

1. Verify the actual operator/controller disclosure required in launch jurisdictions. The owner's preference for brand-only wording does not resolve statutory transparency duties.
2. Supply a working privacy/legal request channel. Do not invent an email address or reuse Degen Arena's support channel. The privacy page expressly says the contact will be published before launch; rights procedures are not represented as operational.
3. Confirm eligibility, restricted locations, regulatory permissions and any verification requirements for prediction markets, NFTs, Council fee allocations and the eventual Intents model with qualified counsel. A generic global policy does not authorise operation everywhere.
4. Inventory the production host, logging, monitoring, wallet and funding providers; actual retention periods; international destinations; and any required transfer safeguards or representatives. No signed SCCs, DPA, DPO appointment, security certification or compliant global transfer mechanism is claimed.
5. Verify the exact custody architecture, supported assets/routes, transaction consent, market rules, NFT licence and fee/distribution terms once contracts are ready. Update the policies alongside those releases.
6. Review and approve the final copy, version/effective date and required assent/notice flow before enabling financial actions. Keep prior policy versions as they are replaced. Enable search indexing only once the legal copy and disclosures are approved.

The original downloaded templates remain unchanged.

## Explicit acceptance flow

- A wallet-enabled connection now opens an accessible policy-review dialog when the connected account has no current local record. Terms agreement and Privacy acknowledgement start unchecked. The links open the actual documents in separate tabs, without discarding the review state. The two legal routes themselves never auto-open this dialog, so a restored pending wallet cannot block the very documents the user needs to read. Choosing Not now or Escape disconnects the pending wallet and preserves public browsing.
- No wallet account is exposed to account-based site features until the two choices are confirmed. `send` additionally checks the current versions and connected account before any existing transaction code. Contract actions remain unavailable as before; this work does not activate them. The sandbox's account-view helper remains read-only and does not impersonate a real wallet acceptance.
- `lib/legal.ts` defines the document versions, account/network-scoped browser keys and clickwrap receipt shape. Pages and the dialog display the same versions. Bump the relevant version on material policy updates. Old or invalid records do not skip review. Blocked storage produces an error, rather than a false success.
- This is **local clickwrap only**. It does not request a wallet signature, verify age, prove the person read the documents, establish legal enforceability, provide a trustworthy timestamp or create a central audit record. A user can modify or delete local storage. The browser check is not backend access control.
- NEAR Connect 0.11.4 supports off-chain NEP-413 `signMessage` and `signInAndSignMessage`. A durable signed flow still needs a backend to issue an origin/network/account/version-bound challenge with a short expiry and single-use nonce, verify the signature and account key, and retain the exact immutable document snapshots/hashes plus a server timestamp and receipt identifier. Do not store an unverified wallet response and call it verified proof. No such backend or signature-verification path has been added here.
- Acceptance of contractual terms is separate from consent for personal-data processing. Privacy acknowledgement does not opt a user into advertising, profiling or other optional processing. Reference: https://ico.org.uk/consent and https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/consent/what-is-valid-consent/.

## Protection review and version 2026-10-19.2

The owner deferred backend work while the contracts are being built and requested a stronger review of the downloaded templates. See [LEGAL-REVIEW.md](LEGAL-REVIEW.md) for implemented wording changes, primary sources, remaining exposure and agreements that need separate treatment. No backend or contract was changed.

Both document versions were incremented to `2026-10-19.2`; old local acknowledgements must be reviewed again. Static copies of versions `.1` and `.2` are preserved under `public/legal/`, with file hashes in `public/legal/manifest.json`. These are document snapshots, not proof that an account accepted them. Preserve existing version files unchanged and add new paths for future versions. A future signature/receipt service must verify its own evidence and cannot retrospectively treat client timestamps as trusted.

The revised public drafts add scoped responsibility for deliberate unlawful conduct, evidence/publication permissions, juror conflicts, limits of unauthorised representation, specific-market-rule priority, transaction/recovery clarification, complaint-vs-challenge distinction, ongoing-position obligations and more explicit privacy-purpose/retention limits. They preserve mandatory rights and do not invent an unrestricted freeze, cancellation, forfeiture, slashing or asset-transfer power.

Brand-only wording remains the owner's requested presentation. The review explicitly flags that missing controller/operator disclosures and a public contact are unresolved exposure, not a legal protection. No licensing, worldwide eligibility, NFT classification, vendor safeguards, insurance or global enforceability claim has been made.

## Full public-copy rewrite: version 2026-10-19.3

Reread and rewrote every section of both documents using the plain-language design skill. Replaced internal instructions with direct explanations of what information the service uses, what a visitor agrees to and what choices are available. The intended audience is the general public; the reading target is grade 6 to 8, without claiming a measured grade score. The review above remains internal rather than becoming more public boilerplate.

The Privacy Policy now separates age requirements from updates. It expressly states that a wallet connection does not currently verify age, and that accepting the Terms does not prove age or identity. The child-information paragraph now explains what we will do if we learn that we control such information. Neither document claims a live identity check, central acceptance database, guaranteed recovery, guaranteed NFT income or enabled financial action. The missing public request contact remains disclosed rather than invented.

Both versions are now `2026-10-19.3`, so existing version `.2` acknowledgements require review again. Preserve the `.1` and `.2` archives unchanged. New standalone `.3` copies and manifest hashes document this rewrite. The local acknowledgement flow, contracts and backend remain unchanged.
