# Wallet identity integration

The API accepts NEAR ownership proofs and EVM externally owned account signatures. This is website
authentication, not an agent grant, a trading signature or a deposit authorization. The backend supports
EVM agent inspection and revocation. The Reown UI, EVM provisioning and execution remain unfinished.
The existing NEAR wallet path stays usable.

## EVM login contract

1. Send `POST /v1/auth/evm/challenge` with JSON `{ "address": "0x...", "chainId": 1 }` and
   `credentials: "include"`. Use the currently selected wallet address and integer chain ID.
2. The response contains `id`, checksummed `address`, `chainId`, `message` and `expiresAt`. The API
   stores the exact SIWE message and sets a five-minute HttpOnly browser-binding cookie.
3. Before signing, validate the complete message against the selected wallet and site: address,
   chain ID, scheme/domain, URI, version, request ID, nonce, issued-at/expiry and the exact statement:
   `Sign in to Dragons Market. This creates a website session. It does not authorize transactions.`
   A familiar prefix is not enough. Do not let an API response turn login into a trading signature.
4. Ask the wallet to sign this message using `personal_sign` / ERC-191. Submit
   `POST /v1/auth/evm/verify` with `{ "id": "...", "signature": "0x..." }` and cookies included.
   Do not submit an address or public key as proof; the API recovers them from the signature.
5. Read `GET /v1/auth/session` and match the returned wallet type, address namespace and chain
   against the still-connected wallet before updating UI state. Recheck after every wallet prompt.

Production cookies use `__Host-`, HttpOnly, Secure, SameSite=Strict and Path=/. API and website must
remain same-site. Duplicate browser cookies, missing/mismatched Origin on writes, expired/consumed
challenges and proof substitution are rejected. Both login methods share the existing client rate
limit and challenge capacity; an EVM endpoint does not provide a second allowance.

Verification uses the stored message, not client-supplied message fields. A rejected signature spends
that browser's challenge. Wrong-browser requests do not. Challenge consumption and session creation
commit in one transaction, so concurrent verification yields at most one session. Login moves no
funds and calls no chain RPC or Agent API endpoint.

This implementation verifies EOA-style recoverable signatures only. It does not implement ERC-1271,
ERC-6492 or arbitrary smart-wallet signatures. EVM chain selection is an authentication scope; it does
not establish that a bridge, token or trading route supports that chain.

## Identity is not a payout destination

| Value | Meaning | Allowed reader |
| --- | --- | --- |
| NEAR `account_id` | Verified NEAR owner account | Existing NEAR session and agent flow |
| EVM `account_id` | `eip155:<chainId>:<lowercase address>` session principal | Session, watchlist, policy acknowledgement, logout and agent ownership lookup |
| `wallet_type` | `near` or `evm`, persisted with challenge and session | API authorization before forwarding to a signing service |
| `evm_chain_id` | Decimal string in session JSON; null for NEAR | Wallet/session matching, never NEAR network selection |
| EVM `public_key` | Recovered uncompressed secp256k1 coordinates, `0x` plus 128 hex digits | Verified Agent API owner descriptor for revocation |

An EVM principal cannot collide with a NEAR account ID. Existing rows default to NEAR in migration
015. Watchlists and logout-all are scoped to the authenticated principal, including its EVM chain.
Switching chain requires another login; it does not automatically link identities or their agents.
The current NEAR browser session reader rejects EVM principals. The API forwards a distinct EVM owner
descriptor only for the inspection/revocation operations below. Both API and private worker reject new
EVM authority or execution with `agent_owner_wallet_not_supported`. The worker independently validates
the NEAR account/Ed25519 key or the EVM principal/address/chain/recovered key at its boundary.

The Reown integration must invalidate pending wallet prompts, quotes and displayed authorization on
account/chain changes or disconnect. An old async response must not restore the previous account's
UI state. Keep EVM connection state separate from the NEAR `account`/`sendTransaction` interface.

## Remaining agent-owner integration

The Agent API describes an EVM owner with address, chain ID and public key. Its EIP-712 owner proofs
are separate from this SIWE login. Its deterministic NEAR authority wallet, the agent's execution
account, an EVM Intents identity and a cash-out destination are also distinct values.

The NEAR agent path retains the provider's exact signer descriptor, validates canonical owner consent in
the browser, and binds MCP approval to the user's local form values and fixed expiry. EVM grant/revoke
consent and create/freeze wallet requests now have signing adapters too. EVM inspection and revocation
are integrated through the API and private worker. Provisioning, policy changes, new grants, MCP approval
and execution remain refused until their policy, consent and funding/exit paths are integrated.

The local Agent API source exposes EVM owner consent as `Authorization` typed data with purpose
`PROVE_OWNERSHIP`, recipient and canonical payload; policy changes use a separate `WalletMessage` schema.
Both use the `NEAR Wallet Contract` domain, version `1`. The authority account is derived from a pinned NEAR
wallet implementation and the recovered EVM public key. Do not substitute the human's `0x` address or the
agent execution account as that authority. Verify the exact schemas and implementation pin against the
selected provider release before implementing signing.

### Implemented EVM grant/revoke signing boundary

`AgentApiClient.generateIntent` can validate an expected EVM owner descriptor supplied by its caller.
It retains only the exact matching address, chain ID and public key. Revocation now passes the verified
EVM session descriptor; creation still requires a NEAR owner. The descriptor uses a lowercase
address, a positive safe-integer chain ID and the recovered 64-byte public key. The address must derive
from that key. The chain is part of the signed canonical owner identity, not a NEAR payout destination.

Backend and browser accept only the provider's exact `Authorization` EIP-712 domain, types and
`PROVE_OWNERSHIP` envelope for `grant_issue` / `grant_revoke`. They independently validate canonical
consent, signer, agent, network, recipient, nonce and lifetime. Extra domain fields (including an
invented EVM `chainId`), extra types, additional permissions and ambiguous JSON are refused.
Calls use the separate `WalletMessage` validator below. Other EVM owner operations remain refused.

`web/lib/agents.ts` accepts an `EvmOwnerSigner` for these two consent operations. The future Reown
adapter supplies `getIdentity()` from its current address/chain state and `signTypedData(payload)`
from the selected wallet client. The signing code snapshots the request, checks identity and expiry
before and after the prompt, recovers the exact public key from the signature, and rejects high-s
signatures. It sends the SDK's raw `{ standard: "eip712", payload, signature }` shape. It does not
construct the provider's internal base58 authorization proof or ask the user for a private key.

The backend verifies this proof again before submitting a stored EVM consent. Grant activation compares
the provider's returned `owner_message` with the persisted signed text; changed permissions or identity
cannot activate the grant, and repeated status observation cannot revive a revoked grant.

Source/protocol check on 10 November: Agent API remote main and local `origin/main` both resolved to
`a10cbbf647b5945dd965dff382d2b0ca25924822`. Its actual typed-data builder and independent signature
verifier accepted the same test proof as Dragons. This is local protocol compatibility evidence.
It is not a real Reown prompt, authority-wallet deployment, production provider test or funded acceptance.
The browser pins `viem` 2.57.17, matching the backend. Keep the EVM provisioning/execution guards until the items
below are closed.

### Implemented EVM create/freeze signing boundary

Creation, freeze and unfreeze use the provider's exact `WalletMessage` domain and field definitions.
Both validators derive the NEAR authority account from the recovered owner key and the pinned
`eip712-wallet-contract.trezu.near` StateInit layout. They accept only mainnet, an empty operations
list, one promise to the configured custody contract, and no preceding callbacks. Creation contains
one `store_wallet_policy` call; freeze/unfreeze contains that call followed by exactly the requested
transition. Transfer actions, additional promises, receivers, methods and arguments are refused.

`AgentApiClient.generateIntent` requires an internal `PolicyExpectation` for these operations:
the configured custody contract, approved normalized policy, next revision and storage refund
beneficiary (null when absent). Existing agents may additionally pin the previously verified custody
account. These expectations must come from the owner use case, never from an HTTP request or the
provider's preview. Missing expectations are rejected before provisioning. Creation additionally
compares the expected policy with the original creation request.

After generation, the adapter reads `/v1/agents/{id}` and `/v1/whoami`, verifies the returned agent ID
and custody account, and builds `policy_approval` itself. It ignores a provider-supplied approval
object. The agent read works before ownership binding; `/wallet` requires completed binding and
cannot be used at this stage. For an existing agent, the readback owner must also match the signer.
The browser receives this locally constructed context, and the worker persists it with the intent.

Both validators compare the preview's policy/hash/revision to that context and recompute the signed
`agent_policy_hash` over tenant, agent, revision and policy. Every call targets the expected custody
public key. Policy storage must be unlocked, have a valid version/signature encoding and a provider
deadline covering the signing window. Only creation can specify a storage refund beneficiary, and
it must match the expected account. Calls are limited to 100 TGas total and at most 1 NEAR attached
to storage; the freeze transition must attach zero. These are rejection ceilings, not estimated fees.

The signed nonce is uint32, timeout is at most ten minutes, and timestamps must be valid whole-second
UTC. The outer signing deadline cannot exceed the signed request's lifetime. The browser checks
account, chain and expiry around the prompt, recovers the signing key and submits the captured bytes.
The worker checks the stored request and signature again before provider submission. General
`policy_update`, deletion, owner changes and arbitrary wallet calls remain unsupported.

This check binds the declared policy commitment; it cannot decrypt or independently attest the
provider's encrypted policy document. Applied-policy readback and custody enforcement are still
required. A wallet signature or provider submission is not proof of final settlement.

The 10 November protocol check used Agent API remote main
`57ed33c22784379f38c3842572368ff45466e581`. Relevant builder, derivation, verifier and API read paths
matched the inspected local source. Its independent verifier accepted test signatures for all three
operations and rejected changed nonces. Postgres tests exercise stored revocation submission and freeze
status reconciliation. EVM policy submission through HTTP remains blocked. These are local compatibility
tests, not a deployed wallet, live Reown prompt or funded run.
No new service, dependency, migration or environment variable is added by this slice.

### NEAR policy argument binding

NEAR creation and freeze/unfreeze now use the same internally built approval context described above. Both worker
and browser validate the exact `store_wallet_policy` fields, custody key, declared policy commitment and refund
beneficiary before signing. Freeze/unfreeze must target that same custody key with zero deposit; extra arguments,
callbacks, receivers and actions are refused. The NEP-366 rejection ceilings remain 300 TGas total and 1 NEAR total,
and the signing deadline must be live and at most ten minutes away. Provider document version and account policy
revision are different counters; the validator must not equate them.

The worker reads the currently applied policy before preparing a transition. A failed latest revision consumes a
revision number but does not supply the rules: a bounded history read must match the latest snapshot and contain
the previous applied policy. Signed or unsynchronized pending work is not bypassed. The generated preview must
still match the expected next revision and exactly those rules with the requested freeze flag.

Stored delegates are rechecked before forwarding a signature; old unsigned requests without approval context need
regeneration. Status observation of already submitted requests continues. The Agent API remains responsible for
cryptographically checking the signed NEP-366 delegate against its prepared request. Dragons does not decrypt the
provider's policy document or independently attest its enforcement.

The protocol source check used Agent API remote main `d2fdb69d14985fd7deddab08ead3c09d25b14c5c` on 10 November.
This slice adds optional worker `AGENT_API_POLICY_SPONSOR` (a public account, never a signing key), explicitly pinned
by the activation packet; blank means unsponsored storage. Real provider credentials, wallet prompts and funded
acceptance remain separate release requirements. No service, dependency or database migration is added.

### Implemented session-to-worker inspection and revocation

The API constructs `AgentOwner` from its verified session record, never a request body or wallet header.
NEAR retains the existing `{ account, publicKey }` transport. EVM uses
`{ type: "evm", account: "eip155:<chain>:<address>", signer: { type, address, chain_id, public_key } }`.
The worker checks the exact fields, requires the principal to match the signer address and chain, and
derives the address from the public key again. Mixed wallet schemas and extra authority fields are refused.
This principal is used for ownership lookup only; it never becomes a NEAR payout destination.

| EVM owner operation | Backend behavior |
| --- | --- |
| List agents, operations, claimable positions and existing MCP connections | Scoped to deployment and the complete authenticated principal; another chain is a different owner |
| Revoke an MCP connection | Revokes only that owner's selected connection; does not contact the provider |
| Revoke provider grants | Revokes local grants/connections and removes sealed grant tokens before preparing EIP-712 revocation consent |
| Submit a revocation | Requires the stored request, matching session signer, unexpired deadline and exact recovered signature; follows provider status |
| Observe an owned intent | Reconciles the existing request; does not create a replacement or submit a signature |
| Create, grant, freeze/unfreeze, approve MCP or execute | Refused; the generic intent submission endpoint also refuses stored non-revocation EVM requests |

A failed or substituted provider response cannot restore locally revoked access. Retrying preparation
uses the retained grant identifier; provider revocation is not complete until its status confirms it.
The final execution authorizer also refuses EVM-owned agents, including existing MCP bearer tokens
and owner changes during an applied-policy read. Opening an inspection route does not open execution.

Local integration tests use real SIWE and EIP-712 signatures, two loopback HTTP servers, the actual SDK
adapter and isolated Postgres schemas. Agent rows and provider responses are fixtures; no custody wallet
is provisioned and no funds move. Tests cover cross-wallet/chain isolation, malformed identities, provider
failure/substitution, expired or changed proofs and the generic submission bypass. The browser still
needs the planned EVM wallet adapter; these endpoints do not make the deployed site EVM-ready.

Release the compatible worker before the API when this reviewed change is deployed. An older worker
rejects the new EVM descriptor; NEAR's transport is unchanged. No new schema, environment variable,
dependency, background task or Railway service is required beyond the already pending migration 015.

The provider withdrawal schema accepts a destination chain and recipient, and supports a dry preview.
That interface alone does not prove a route for Dragons' collateral or its settlement: EVM cash-out must
resolve a supported chain/token pair, show fees and received amount, pin the owner's destination, and track
the same operation through bridge settlement/refund. The existing NEAR cash-out proof cannot certify it.

Before enabling EVM provisioning or execution:

- Pin and verify supported EVM ownership against the provider's `/v1/network` and approved wallet
  implementation. Never infer EVM-owner support from native EVM transaction signing support.
- Extend the verified session path beyond inspection/revocation. Construct the expected
  policy/revision from locally approved rules and current applied state, pin the storage sponsor, and
  persist the returned signing context. The new adapters do not themselves open the EVM routes.
- Bind EVM-signed MCP connection consent to the agent, tools, limits, expiry and origin. Login alone
  cannot issue a connection token or change its spending policy.
- Define and prove funding and cash-out routes for the selected EVM owner. Do not insert an EVM
  address or session principal into a NEAR withdrawal field, or silently treat the authority wallet
  as a completed cash-out to the person's EVM wallet.
- Connect the planned EVM wallet adapter and test account/chain switching through creation, authorization,
  freeze/revoke, MCP use and final cash-out. Production credentials and funded acceptance remain
  required before advertising this capability.

## Release and recovery

Apply migration 015 through the existing database-release job before the new API starts. Existing
table grants cover the added columns; no additional service or privileged database credential is
needed. Database integration tests exercise fresh migrations and session behavior locally.

The migration is additive, but an old API does not understand EVM sessions and the schema readiness
check refuses an unknown migration. Prefer a forward fix with the current schema. If a rollback is
required, stop authentication traffic, revoke EVM sessions/challenges, and use a reviewed application
build compatible with migration 015. Do not delete the migration history or restore a database over
newer financial operations simply to make the old health check pass.

Protocol references: [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361),
[ERC-191](https://eips.ethereum.org/EIPS/eip-191), and
[Viem message recovery](https://viem.sh/docs/utilities/recoverMessageAddress).
[EIP-712](https://eips.ethereum.org/EIPS/eip-712) specifies the typed signing format; replay protection
still depends on the request nonce, deadline and the provider/contract's consumption rules.
