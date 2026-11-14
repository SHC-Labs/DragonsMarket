import { nearPolicyRequest } from "./agent-near-policy";
import { BackendError, backendEnabled, call } from "./backend";
import { config } from "./config";
import { formatMoney } from "./format";
import { txEvents, view } from "./rpc";
import { accessConsentMatches, type AccessRequest } from "./agent-access-consent";
import { ownerConsentMatches } from "./agent-owner-consent";
import { evmConsent, signEvmConsent, type EvmOwner, type EvmOwnerSigner } from "./agent-evm-consent";
import { evmPolicyRequest } from "./agent-evm-policy";
import type { PolicyApproval } from "./agent-policy-approval";

export type { AccessRequest } from "./agent-access-consent";

export type Venue = "rounds" | "market";
export type AgentAction =
  | { kind: "stake"; series: number; round: string; side: "up" | "down"; amount: string; minShares: string }
  | { kind: "claim"; series: number; round: string }
  | { kind: "buy"; market: string; side: "yes" | "no"; amount: string; minShares: string }
  | { kind: "sell"; market: string; side: "yes" | "no"; shares: string; minCollateral: string }
  | { kind: "redeem"; market: string }
  | { kind: "withdraw"; venue: Venue; amount: string }
  | { kind: "cash_out"; amount: string }
  | { kind: "leave"; venue: Venue };

export interface OwnerIntent {
  correlation_id: string;
  type: "agent_create" | "grant_issue" | "grant_revoke" | "agent_freeze" | "agent_unfreeze";
  agent_id: string;
  status: string;
  expires_at: string;
  signer: { type: "near"; account_id: string; public_key: string } | EvmOwner;
  intent: { standard: string; payload: Record<string, unknown> };
  preview: Record<string, unknown> & { summary: string };
  policy_approval?: PolicyApproval;
}
export interface AgentView {
  agent_id: string;
  name: string;
  state: "pending" | "active";
  frozen: boolean;
  near_account_id: string | null;
  authorized_until: string | null;
  open_intents: { status: string; generated: OwnerIntent }[];
}
export interface IntentStatus { correlation_id: string; status: string; failure_code: string | null }
export interface ActionResult { operation: string; state: string; evidence: Record<string, unknown> | null }
export interface AgentOperation {
  id: string;
  kind: string;
  state: string;
  transaction_hash: string | null;
  evidence: Record<string, unknown> | null;
  action: AgentAction | null;
  updated_at: string;
}
export interface ClaimableStake { series: number; round: string; side: string; amount: string; outcome: string }
export interface AmountLimits { perTransaction: bigint; daily: bigint }
export interface AgentsSetup {
  rounds: string | null;
  market: string | null;
  token: string;
  cashOut: AmountLimits | null;
  spend: AmountLimits | null;
}
export interface OpenMarket { id: string; title: string; status: string; price_yes: string; price_no: string }
export interface HeldPosition {
  market_id: string;
  title: string;
  yes: string;
  no: string;
  status: string;
  redeemable: string;
}
export interface AccessToken {
  id: string;
  label: string;
  max_spend: string;
  daily_limit: string;
  expires_at: string;
  last_used_at: string | null;
}
export interface IssuedAccess extends Omit<AccessToken, "last_used_at"> { token: string }

interface DelegatePayload { receiverId: string; actions: unknown[] }
export interface OwnerSigner {
  accountId: string;
  signMessage(params: { message: string; recipient: string; nonce: Uint8Array }):
    Promise<{ accountId?: string; publicKey: string; signature: string }>;
  signDelegateActions(params: { delegateActions: DelegatePayload[] }): Promise<{ signedDelegateActions: string[] }>;
}

const backend = <T>(path: string, body?: unknown) =>
  call<T>(path, body === undefined ? {} : { method: "POST", body }).then((reply) => reply.body);

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NONCE = /^[A-Za-z0-9+/]{43}=$/;

const guardedContracts = () => new Set(["intents.near", "intents.far", config.verifierId,
  config.collateralTokenId.slice("nep141:".length), config.tokenId, config.marketId, config.oracleId, config.councilId,
  config.nftId].filter((id) => id !== ""));

const pinned = (value: unknown, expected: string): value is string => expected !== "" && value === expected;

function messageIsSafe(payload: Record<string, unknown>) {
  return Object.keys(payload).every(key => ["message", "recipient", "nonce"].includes(key))
    && typeof payload.message === "string" && pinned(payload.recipient, config.agentApiHost)
    && !guardedContracts().has(payload.recipient) && typeof payload.nonce === "string" && NONCE.test(payload.nonce);
}

export function safeToSign(generated: OwnerIntent) {
  if (generated.status !== "PENDING_SIGNATURE" || !/^intent_[A-Za-z0-9_-]{1,128}$/.test(generated.correlation_id)
    || !/^[0-9a-f]{64}$/.test(generated.agent_id)) return false;
  const { standard, payload } = generated.intent;
  if (standard === "eip712") return config.network === "mainnet" && (ownerConsentMatches(generated)
    || (!guardedContracts().has(config.agentWalletContract)
      && evmPolicyRequest(generated, config.agentWalletContract, generated.policy_approval) !== null));
  return standard === "nep413" ? generated.signer?.type === "near"
    && messageIsSafe(payload) && ownerConsentMatches(generated)
    : standard === "nep366" && generated.signer?.type === "near" && !guardedContracts().has(config.agentWalletContract)
      && nearPolicyRequest(generated, config.agentWalletContract, generated.policy_approval);
}

export interface RoundRules { minStake: bigint; maxOpen: number; paused: boolean }

export function stakeBlock(rules: RoundRules, openStakes: number, held: { side: string } | null, side: string,
  amount: bigint) {
  if (rules.paused) return "Rounds are paused.";
  if (amount > 0n && amount < rules.minStake) {
    return `The smallest stake is ${formatMoney(rules.minStake)} ${config.tokenSymbol}.`;
  }
  if (held && held.side !== side) return "The agent already staked the other side of this round.";
  if (!held && openStakes >= rules.maxOpen) return "Claim a settled round before staking in another.";
  return null;
}

const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);

export function roundWait(opensAt: string, closesAt: string, now: number) {
  if (now >= nsToMs(closesAt)) return "This round has closed. The next one is on its way.";
  const left = Math.ceil((nsToMs(opensAt) - now) / 1000);
  if (left <= 0) return null;
  return `This round opens in ${left >= 60 ? `${Math.ceil(left / 60)} min` : `${left} sec`}.`;
}

export type ActionOutcome = "done" | "refused" | "review" | "settling";
const OUTCOMES: Record<string, ActionOutcome> = { confirmed: "done", failed: "refused", reconcile: "review" };
export const outcomeOf = (state: string): ActionOutcome =>
  (Object.hasOwn(OUTCOMES, state) ? OUTCOMES[state]! : "settling");

export async function depositedFor(txHash: string, owner: string, contract: string, agent: string,
  standard: Venue = "rounds") {
  const credited = (await txEvents(txHash, owner)).find((e) => e.executor === contract && e.standard === standard
    && e.event === "deposit" && e.data.account === agent);
  const amount = credited?.data.amount;
  return typeof amount === "string" && /^\d{1,39}$/.test(amount) ? BigInt(amount) : null;
}

const MARKET_WINDOW = 50n;

export async function openMarkets(contract: string) {
  const { markets } = await view<{ markets: string }>(contract, "config");
  const total = BigInt(markets), from = total > MARKET_WINDOW ? total - MARKET_WINDOW : 0n;
  const listed = await view<OpenMarket[]>(contract, "list_markets",
    { from_index: from.toString(), limit: MARKET_WINDOW.toString() });
  return listed.filter((m) => m.status === "open");
}

export async function heldPositions(contract: string, account: string): Promise<HeldPosition[]> {
  const held = await view<Omit<HeldPosition, "title">[]>(contract, "get_positions",
    { account_id: account, limit: "100" });
  return Promise.all(held.map(async (p) => {
    const market = await view<{ title: string } | null>(contract, "get_market", { market_id: p.market_id });
    return { ...p, title: market?.title ?? `Market ${p.market_id}` };
  }));
}

const units = (value: unknown) => (typeof value === "string" && /^\d{1,39}$/.test(value) ? BigInt(value) : null);

function amountLimits(published: { perTransaction?: unknown; daily?: unknown } | null | undefined) {
  const [perTransaction, daily] = [units(published?.perTransaction), units(published?.daily)];
  return perTransaction && daily ? { perTransaction, daily } : null;
}

export function agentsSetup(): Promise<AgentsSetup | null> {
  if (!backendEnabled()) return Promise.resolve(null);
  type Published = {
    capabilities?: { agents?: boolean };
    deployment?: { collateralTokenId: string; contracts: { rounds?: string; market?: string } };
    agentCashOut?: { perTransaction?: unknown; daily?: unknown } | null;
    agentSpend?: { perTransaction?: unknown; daily?: unknown } | null;
  };
  return backend<Published>("/v1/config").then((c) => (c.capabilities?.agents && c.deployment
    ? { rounds: c.deployment.contracts.rounds ?? null, market: c.deployment.contracts.market ?? null,
      token: c.deployment.collateralTokenId.slice("nep141:".length), cashOut: amountLimits(c.agentCashOut),
      spend: amountLimits(c.agentSpend) }
    : null));
}

export async function signIntent(
  generated: OwnerIntent, signer: OwnerSigner | EvmOwnerSigner,
): Promise<Record<string, unknown>> {
  generated = structuredClone(generated);
  if (!safeToSign(generated)) {
    throw new Error("Dragons Market stopped this request before your wallet, because it could move your funds.");
  }
  if ("type" in signer) {
    const payload = evmConsent(generated.intent.payload, config.agentApiHost)
      ?? evmPolicyRequest(generated, config.agentWalletContract, generated.policy_approval);
    if (generated.signer.type !== "evm" || !payload) throw new Error("This request needs a different owner wallet.");
    return signEvmConsent({ owner: generated.signer, payload, expiresAt: generated.expires_at }, signer);
  }
  const { standard, payload } = generated.intent;
  if (generated.signer?.type !== "near"
    || generated.signer.account_id !== signer.accountId || !(Date.parse(generated.expires_at) > Date.now())) {
    throw new Error("Dragons Market stopped this request before your wallet, because it could move your funds.");
  }
  if (standard === "nep366") {
    const delegateActions = [payload as unknown as DelegatePayload];
    const { signedDelegateActions } = await signer.signDelegateActions({ delegateActions });
    if (signedDelegateActions.length !== 1 || !signedDelegateActions[0]) {
      throw new Error("Your wallet did not return exactly one signature.");
    }
    if (!(Date.parse(generated.expires_at) > Date.now())) throw new Error("That request expired while signing.");
    return { standard, payload, signed_delegate: signedDelegateActions[0] };
  }
  const message = payload as { message: string; recipient: string; nonce: string };
  const signed = await signer.signMessage({ message: message.message, recipient: message.recipient,
    nonce: bytes(message.nonce) });
  if (signed.accountId !== signer.accountId || signed.publicKey !== generated.signer.public_key) {
    throw new Error("Your wallet signed with a different account or key. Sign in again with the agent's owner wallet.");
  }
  if (!(Date.parse(generated.expires_at) > Date.now())) throw new Error("That request expired while signing.");
  return { standard, payload, public_key: signed.publicKey, signature: signed.signature };
}

const SETTLED = new Set(["SUCCESS", "FAILED", "REFUNDED", "NEEDS_REVIEW", "PENDING_SIGNATURE"]);
const intentPath = (id: string) => `/v1/agent-intents/${id}`;
const intentStatus = (id: string) => backend<IntentStatus>(`${intentPath(id)}/status`, {});

export async function followIntent(correlationId: string, first?: IntentStatus) {
  let status = first ?? (await intentStatus(correlationId));
  for (let tries = 0; !SETTLED.has(status.status) && tries < 60; tries++) {
    await pause(2000);
    status = await intentStatus(correlationId);
  }
  return status;
}

export async function signAndFollow(generated: OwnerIntent, signer: OwnerSigner | EvmOwnerSigner) {
  generated = structuredClone(generated);
  const signed = await signIntent(generated, signer);
  const path = intentPath(generated.correlation_id);
  return followIntent(generated.correlation_id, await backend<IntentStatus>(path, { signed_data: signed }));
}

export const listAgents = () => backend<{ data: AgentView[] }>("/v1/agents").then((r) => r.data);

export async function refreshAgents() {
  const agents = await listAgents();
  const moving = agents.flatMap((a) => a.open_intents).filter((i) => i.status !== "PENDING_SIGNATURE");
  if (!moving.length) return agents;
  await Promise.all(moving.map((i) => intentStatus(i.generated.correlation_id).catch(() => null)));
  return listAgents();
}
export const createAgent = (name: string) => backend<OwnerIntent>("/v1/agents", { name });
export const issueGrant = (agentId: string) => backend<OwnerIntent>(`/v1/agents/${agentId}/grant`, {});
export const revokeGrants = (agentId: string) =>
  backend<{ data: OwnerIntent[] }>(`/v1/agents/${agentId}/revoke`, {}).then((r) => r.data);
export const freezeAgent = (agentId: string, frozen: boolean) =>
  backend<OwnerIntent>(`/v1/agents/${agentId}/${frozen ? "freeze" : "unfreeze"}`, {});
export const agentOperations = (agentId: string) =>
  backend<{ data: AgentOperation[] }>(`/v1/agents/${agentId}/operations`).then((r) => r.data);
export const agentClaimable = (agentId: string) =>
  backend<{ data: ClaimableStake[] }>(`/v1/agents/${agentId}/claimable`).then((r) => r.data);
export const accessTokens = (agentId: string) =>
  backend<{ data: AccessToken[] }>(`/v1/agents/${agentId}/access`).then((r) => r.data);
export const requestAccess = (agentId: string, label: string, maxSpend: string, dailyLimit: string) =>
  backend<Omit<AccessRequest, "terms">>(`/v1/agents/${agentId}/access`,
    { label, max_spend: maxSpend, daily_limit: dailyLimit }).then(request => ({ ...request,
    terms: { agentId, label, maxSpend, dailyLimit } }));

export async function signAccess(agentId: string, asked: AccessRequest, signer: OwnerSigner,
  origin = globalThis.location?.origin) {
  if (!accessConsentMatches(asked, agentId, signer.accountId, origin)) {
    throw new Error("Dragons Market stopped this request before your wallet, because it did not match this site.");
  }
  const signed = await signer.signMessage({ message: asked.message, recipient: asked.recipient,
    nonce: bytes(asked.nonce) });
  if (signed.accountId !== signer.accountId) throw new Error("Your wallet signed for a different account.");
  if (!accessConsentMatches(asked, agentId, signer.accountId, origin)) {
    throw new Error("That connection request changed or expired while your wallet was open. Start again.");
  }
  return backend<IssuedAccess>(`/v1/agents/${agentId}/access/${asked.id}/sign`,
    { public_key: signed.publicKey, signature: signed.signature });
}

export const revokeAccess = (agentId: string, tokenId: string) =>
  backend<{ revoked: boolean }>(`/v1/agents/${agentId}/access/${tokenId}/revoke`, {});
export const actionKey = () => `ui-${crypto.randomUUID()}`;

const UNSETTLED = new Set(["prepared", "submitted", "unknown"]);
const mayHaveSent = (e: unknown) => !(e instanceof BackendError) || e.code === "unreachable" || e.status >= 500
  || e.status === 429 || e.code === "operation_in_progress";

export async function runAction(agentId: string, key: string, action: AgentAction) {
  let result: ActionResult = { operation: "", state: "unknown", evidence: null };
  for (let tries = 0; tries < 40; tries++) {
    if (tries > 0) await pause(2000);
    try {
      result = await backend<ActionResult>(`/v1/agents/${agentId}/actions`, { key, action });
    } catch (e) {
      if (!mayHaveSent(e)) throw e;
      continue;
    }
    if (!UNSETTLED.has(result.state)) return result;
  }
  return result;
}

const MESSAGES: Record<string, string> = {
  unreachable: "Could not reach Dragons Market. Check your connection and try again.",
  session_required: "Sign in to Dragons Market again to continue.",
  agent_limit_reached: "You already have three agents.",
  grant_required: "Authorize Dragons Market for this agent first.",
  agent_frozen: "The agent is already frozen.",
  agent_not_frozen: "The agent is not frozen.",
  wallet_frozen: "The agent is frozen. New actions are blocked; actions already sent may still settle.",
  policy_not_ready: "The agent's policy is not applied and synchronized yet. Check its status before retrying.",
  provider_policy_mismatch: "The agent's current policy differs from the approved trading policy. Ask the owner to review it.",
  agent_authorization_stale: "This agent's authorization is no longer valid. The owner needs to review its access.",
  access_token_invalid: "This connection has expired or been revoked. Ask the owner for new access.",
  custody_native_balance_required: "The agent needs more NEAR for gas. Send it some and try again.",
  invalid_signature: "That signature did not match this request, so nothing was given. Try again.",
  access_request_not_found: "That request expired before it was signed. Start it again.",
  access_request_changed: "That connection request no longer matches its permissions. Create a new request.",
  agent_api_unavailable: "The agent service is not answering. Try again in a minute.",
  agent_api_rate_limited: "The agent service is busy. Try again in a minute.",
  intent_expired: "That request expired before it was signed. Start it again.",
  policy_destination_denied: "The agent's rules do not allow sending there.",
  policy_transaction_limit_exceeded: "That is more than the agent's rules allow at once. Try a smaller amount.",
  policy_limit_exceeded: "That would pass the agent's limit for 24 hours. Try a smaller amount, or wait.",
  native_method_denied: "The agent's rules do not allow that call.",
  insufficient_balance: "The agent does not hold enough for that.",
  access_token_limit_reached: "This agent already has five connections. Revoke one first.",
  daily_limit_below_max_spend: "The limit for 24 hours must be at least the limit for one stake or buy.",
  spend_over_limit: "That is more than this agent may spend at once. Try a smaller amount.",
  daily_limit_reached: "That would exceed this spending allowance. Unsettled trades stay reserved until their outcome is known.",
  slippage_too_wide: "The price moved too far from that quote, so nothing was sent. Try again.",
};

export const refusalMessage = (code: unknown) =>
  (typeof code === "string" && Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : null);

export function agentError(e: unknown): string {
  if (e instanceof BackendError) return refusalMessage(e.code) ?? `The request was refused (${e.code}).`;
  return e instanceof Error ? e.message : "Something went wrong.";
}
