import { BackendError, backendEnabled, call } from "./backend";
import { config } from "./config";
import { formatMoney } from "./format";
import { txEvents } from "./rpc";

export type AgentAction =
  | { kind: "stake"; series: number; round: string; side: "up" | "down"; amount: string; minShares: string }
  | { kind: "claim"; series: number; round: string }
  | { kind: "withdraw"; contract: "rounds"; amount: string }
  | { kind: "cash_out"; amount: string };

export interface OwnerIntent {
  correlation_id: string;
  type: "agent_create" | "grant_issue" | "grant_revoke" | "agent_freeze" | "agent_unfreeze";
  agent_id: string;
  status: string;
  expires_at: string;
  intent: { standard: string; payload: Record<string, unknown> };
  preview: { summary: string };
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
export interface CashOutLimits { perTransaction: bigint; daily: bigint }
export interface AgentsSetup { rounds: string | null; token: string; cashOut: CashOutLimits | null }
export interface AccessToken {
  id: string;
  label: string;
  max_stake: string;
  daily_limit: string;
  expires_at: string;
  last_used_at: string | null;
}
export interface IssuedAccess extends Omit<AccessToken, "last_used_at"> { token: string }

interface DelegatePayload { receiverId: string; actions: unknown[] }
export interface OwnerSigner {
  signMessage(params: { message: string; recipient: string; nonce: Uint8Array }):
    Promise<{ accountId?: string; publicKey: string; signature: string }>;
  signDelegateActions(params: { delegateActions: DelegatePayload[] }): Promise<{ signedDelegateActions: string[] }>;
}

const backend = <T>(path: string, body?: unknown) =>
  call<T>(path, body === undefined ? {} : { method: "POST", body }).then((reply) => reply.body);

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const NONCE = /^[A-Za-z0-9+/]{43}=$/;
const NEAR = 10n ** 24n;
const MOVES_ASSETS = new Set(["ft_transfer", "ft_transfer_call", "mt_transfer", "mt_transfer_call", "mt_batch_transfer",
  "mt_batch_transfer_call", "nft_transfer", "nft_transfer_call", "ft_withdraw", "mt_withdraw", "storage_withdraw",
  "storage_unregister", "withdraw", "transfer"]);

const guardedContracts = () => new Set(["intents.near", "intents.far", config.verifierId,
  config.collateralTokenId.slice("nep141:".length), config.tokenId, config.marketId, config.oracleId, config.councilId,
  config.nftId].filter((id) => id !== ""));

function messageIsSafe(payload: Record<string, unknown>) {
  return typeof payload.message === "string" && typeof payload.recipient === "string"
    && !guardedContracts().has(payload.recipient) && typeof payload.nonce === "string" && NONCE.test(payload.nonce);
}

function delegateIsSafe(payload: Record<string, unknown>) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const deposits = actions.map((a) => {
    const params = isRecord(a) && a.type === "FunctionCall" && isRecord(a.params) ? a.params : null;
    const fine = params && typeof params.methodName === "string" && !MOVES_ASSETS.has(params.methodName)
      && typeof params.deposit === "string" && /^\d{1,39}$/.test(params.deposit);
    return fine ? BigInt(params.deposit as string) : null;
  });
  return typeof payload.receiverId === "string" && !guardedContracts().has(payload.receiverId) && deposits.length > 0
    && !deposits.includes(null) && deposits.reduce<bigint>((sum, d) => sum + d!, 0n) <= NEAR;
}

export function safeToSign(standard: string, payload: Record<string, unknown>) {
  return standard === "nep413" ? messageIsSafe(payload) : standard === "nep366" && delegateIsSafe(payload);
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

export type ActionOutcome = "done" | "refused" | "review" | "settling";
const OUTCOMES: Record<string, ActionOutcome> = { confirmed: "done", failed: "refused", reconcile: "review" };
export const outcomeOf = (state: string): ActionOutcome =>
  (Object.hasOwn(OUTCOMES, state) ? OUTCOMES[state]! : "settling");

export async function depositedFor(txHash: string, owner: string, rounds: string, agent: string) {
  const credited = (await txEvents(txHash, owner)).find((e) => e.executor === rounds && e.standard === "rounds"
    && e.event === "deposit" && e.data.account === agent);
  const amount = credited?.data.amount;
  return typeof amount === "string" && /^\d{1,39}$/.test(amount) ? BigInt(amount) : null;
}

const units = (value: unknown) => (typeof value === "string" && /^\d{1,39}$/.test(value) ? BigInt(value) : null);

function cashOutLimits(published: { perTransaction?: unknown; daily?: unknown } | null | undefined) {
  const [perTransaction, daily] = [units(published?.perTransaction), units(published?.daily)];
  return perTransaction && daily ? { perTransaction, daily } : null;
}

export function agentsSetup(): Promise<AgentsSetup | null> {
  if (!backendEnabled()) return Promise.resolve(null);
  type Published = {
    capabilities?: { agents?: boolean };
    deployment?: { collateralTokenId: string; contracts: { rounds?: string } };
    agentCashOut?: { perTransaction?: unknown; daily?: unknown } | null;
  };
  return backend<Published>("/v1/config").then((c) => (c.capabilities?.agents && c.deployment
    ? { rounds: c.deployment.contracts.rounds ?? null, token: c.deployment.collateralTokenId.slice("nep141:".length),
      cashOut: cashOutLimits(c.agentCashOut) }
    : null));
}

export async function signIntent(generated: OwnerIntent, signer: OwnerSigner): Promise<Record<string, unknown>> {
  const { standard, payload } = generated.intent;
  if (!safeToSign(standard, payload)) {
    throw new Error("Dragons Market stopped this request before your wallet, because it could move your funds.");
  }
  if (standard === "nep366") {
    const delegateActions = [payload as unknown as DelegatePayload];
    const { signedDelegateActions } = await signer.signDelegateActions({ delegateActions });
    if (!signedDelegateActions[0]) throw new Error("Your wallet returned no signature.");
    return { standard, payload, signed_delegate: signedDelegateActions[0] };
  }
  const message = payload as { message: string; recipient: string; nonce: string };
  const signed = await signer.signMessage({ ...message, nonce: bytes(message.nonce) });
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

export async function signAndFollow(generated: OwnerIntent, signer: OwnerSigner) {
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
export const accessTokens = (agentId: string) =>
  backend<{ data: AccessToken[] }>(`/v1/agents/${agentId}/access`).then((r) => r.data);
export const giveAccess = (agentId: string, label: string, maxStake: string, dailyLimit: string) =>
  backend<IssuedAccess>(`/v1/agents/${agentId}/access`, { label, max_stake: maxStake, daily_limit: dailyLimit });
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
  agent_frozen: "The agent is frozen. Unfreeze it to stake again; it can still pay out to you.",
  agent_not_frozen: "The agent is not frozen.",
  agent_api_unavailable: "The agent service is not answering. Try again in a minute.",
  agent_api_rate_limited: "The agent service is busy. Try again in a minute.",
  intent_expired: "That request expired before it was signed. Start it again.",
  policy_destination_denied: "The agent's rules do not allow sending there.",
  policy_transaction_limit_exceeded: "That is more than the agent's rules allow at once. Try a smaller amount.",
  policy_limit_exceeded: "That would pass the agent's limit for 24 hours. Try a smaller amount, or wait.",
  native_method_denied: "The agent's rules do not allow that call.",
  insufficient_balance: "The agent does not hold enough for that.",
  access_token_limit_reached: "This agent already has five connections. Revoke one first.",
  daily_limit_below_max_stake: "The limit for 24 hours must be at least the limit for one stake.",
};

export const refusalMessage = (code: unknown) =>
  (typeof code === "string" && Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : null);

export function agentError(e: unknown): string {
  if (e instanceof BackendError) return refusalMessage(e.code) ?? `The request was refused (${e.code}).`;
  return e instanceof Error ? e.message : "Something went wrong.";
}
