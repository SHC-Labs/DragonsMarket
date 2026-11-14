# NFT platform custody

The owner accepted retaining the collection owner's Cookon platform key on November 12, 2026 so the platform can
deploy fixes and upgrades. This supersedes the earlier requirement to remove that collection's
key before activation. No key was removed, transferred or provisioned by this work.

The collection is `techdragons.nft.cookon.near`. The November 11 inspection observed stored owner
`cookon.near` and full-access public key
`ed25519:67k6LHXYbFdM5ikxUtAmoZwV7c7HqdYXepcKoDscx3AC`. The collection owner confirmed control to the owner.
These are public identifiers; the application never needs the collection owner's private key.

A read-only check on November 12 confirmed the same owner and single key on both
`rpc.mainnet.near.org` and `free.rpc.fastnear.com` at finalized block `224222260`
(`GWrgix3hNciVBJXgJrmeeFcrPH6SvSCdY5qJsARC6kyE`). Both reported code hash
`G1xjjqLxPB126dMnsPxfoKxQsEsFDfpXASvv2hmLVWzM`. This is an observation, not source/build approval.

The platform remains trusted to administer this NFT collection. A full-access key can replace
its code and change its account authority; a mint treasury pointing to the DAO does not limit
those powers. NFT ownership decides Council seats, so platform custody is a dependency of
dispute resolution. This is the accepted custody model, not a claim that the collection is keyless.
Market, Oracle, Council, optional Rounds and the owner DAO still require zero NEAR access keys.

## One policy for all three checks

`contracts/keeper/nft-custody.mjs` implements the shared validation used by:

- `KEEPER_APPROVAL_JSON.nftCustody`, consumed by activation and the backend keeper before signing.
- `nftCustody` in the production deployment manifest, consumed by `nft-ready` before proposing seats.
- A JSON file passed to `keeper.mjs check --nft-custody FILE --expect-sealed`.

The policy shape is:

```json
{
  "mode": "platform-managed",
  "accountId": "techdragons.nft.cookon.near",
  "ownerId": "cookon.near",
  "codeHash": "FILL_approved_NFT_code_hash",
  "publicKeys": ["ed25519:67k6LHXYbFdM5ikxUtAmoZwV7c7HqdYXepcKoDscx3AC"],
  "custodian": "Cookon",
  "reviewEvidence": "FILL_https_review_record_including_retained_platform_key"
}
```

The placeholders deliberately fail validation. Retaining the key is already accepted; the
source/build match and final mint terms remain separate evidence requirements. Do not promote
an observed code hash into an approved build without that review. The review URL is a record,
not a signature or an automatically fetched authorization. Protect the policy and approval
digest with the same reviewed deployment controls as the rest of the release configuration.

The exact key set and full-access permissions must match. Additional, removed, replaced or
duplicate keys fail. Normal transaction nonce changes are ignored. The stored owner returned by
`get_owner`, account identity and code hash must match; mutable global code references fail.
The backend also compares the policy's code hash with `contracts.nft.codeHash` and retains its source
commit/build evidence requirement. Both RPC providers read the same recent finalized block
before keeper submission. Missing or disagreeing evidence stops that submission.

Omitting the policy, or selecting `{ "mode": "keyless" }`, preserves the original zero-key
requirement. This policy cannot exempt a financial contract or the owner DAO from their checks.

## Platform updates and recovery

Coordinate collection upgrades or key rotations with the collection owner. Review the new source/build or key
inventory, update this policy in the manifest and expiring keeper approval, recompute the
approval digest, then run the read-only approval check on both providers before resuming the
keeper. An unreviewed platform update stops keeper signing until the refreshed approval matches.
Do not delete the platform key as an incident workaround or automatically accept a newly observed key.

These checks cannot prevent a platform key holder from changing the NFT contract or reverse
an on-chain update. Application rollback does not roll back NFT code. If collection authority
changes unexpectedly, stop new market admission through the existing operator procedure,
contact the collection owner, inspect affected seats and positions, and preserve user exits. Do not clear an
incident by copying live hashes into the approval. Public minting still needs the actual reviewed
interface, approved sale terms, seat eligibility and funded wallet acceptance.
