import {
  AgentApiError, createAgentApi, type AgentApi, type GenerateIntentRequest, type IntentType, type SignedData,
  type Status,
} from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import { isAccount as account } from './validate.js';
import type { Owner } from './agent-paths.js';
import { isEvmOwner, type EvmOwner } from './agent-evm-consent.js';
import { evmPolicyRequest } from './agent-evm-policy.js';
import { nearPolicyRequest } from './agent-near-policy.js';
import type { PolicyApproval, PolicyExpectation } from './agent-policy-approval.js';

export { AgentApiError };

export interface AgentApiSettings {
  url: string;
  key: string;
  timeoutMs: number;
}

export interface AgentGrant {
  agentId: string;
  token: string;
}

export interface NativeCall {
  receiver_id: string;
  method_name: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

export interface Withdrawal {
  asset: string;
  amount: string;
  chain: 'near';
  recipient: string;
}

export type Send = { native: NativeCall } | { withdraw: Withdrawal };

export interface AgentStatus {
  correlation_id: string;
  type: string;
  status: Status;
  failure_code: string | null;
  details: Record<string, unknown>;
}

export interface AccountPolicy {
  status: 'NONE' | 'SIGNED' | 'APPLIED' | 'FAILED';
  revision: number | null;
  synced: boolean;
  policy: Record<string, unknown> | null;
}
export interface PolicyRevision {
  revision: number;
  status: AccountPolicy['status'];
  policy: Record<string, unknown> | null;
}

export function appliedFreeze(policy: AccountPolicy): boolean | null {
  if (policy.status !== 'APPLIED' || !policy.synced || policy.revision === null
    || policy.revision < 1 || typeof policy.policy?.frozen !== 'boolean') return null;
  return policy.policy.frozen;
}

export interface OwnerIntent {
  correlation_id: string;
  type: IntentType;
  agent_id: string;
  status: string;
  expires_at: string;
  signer: { type: 'near'; account_id: string; public_key: string } | EvmOwner;
  intent: { standard: string; payload: Record<string, unknown> };
  preview: Record<string, unknown> & { summary: string };
  policy_approval?: PolicyApproval;
}

export interface Expected {
  type: string;
  agentId: string;
  correlationId?: string;
  fits?: (details: Record<string, unknown>) => boolean;
}

export class AgentApiUnavailable extends Error {}

export interface GrantCalls {
  send(idempotencyKey: string, send: Send, expected: Expected): Promise<AgentStatus>;
}

const SETTLED: Record<Status, boolean> = {
  PENDING_SIGNATURE: false, PENDING_APPROVAL: false, PENDING_DEPOSIT: false, QUEUED: false, PROCESSING: false,
  UNCERTAIN: false, SUCCESS: true, FAILED: true, REFUNDED: true, NEEDS_REVIEW: true,
};
export const settled = (status: Status) => SETTLED[status];

const SENT_NOTHING = new Set([
  'policy_action_denied', 'policy_destination_denied', 'policy_asset_denied', 'policy_schedule_denied',
  'spend_budget_exceeded', 'spend_price_unavailable', 'policy_transaction_limit_exceeded', 'policy_limit_exceeded',
  'policy_action_limit_exceeded', 'policy_usage_unavailable', 'insufficient_balance', 'provider_refused', 'wallet_busy',
  'policy_denied', 'policy_not_ready', 'provider_policy_mismatch', 'authorization_stale', 'agent_archived',
  'wallet_frozen', 'agent_grant_required', 'native_method_denied', 'custody_native_balance_required',
  'invalid_request', 'invalid_address', 'amount_too_low', 'route_unavailable', 'quote_unavailable',
  'refund_address_required', 'unsupported_chain', 'unsupported_token',
]);
const client4xx = (e: AgentApiError) => e.status >= 400 && e.status < 500;
export const sentNothing = (e: unknown) => e instanceof AgentApiError && client4xx(e) && SENT_NOTHING.has(e.code);
export const finalRefusal = (e: unknown) => e instanceof AgentApiError && client4xx(e) && !e.retryable
  && ![408, 425, 429].includes(e.status);

const CODE = /^[a-z0-9_]{1,64}$/;
export const refusalCode = (e: AgentApiError) => (CODE.test(e.code) ? e.code : 'agent_api_refused');

const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_WAIT_MS = 25000;
const AGENT_ID = /^[0-9a-f]{64}$/;
const CORRELATION = /^(op|intent)_[A-Za-z0-9_-]{1,128}$/;

function untrusted(what: string): never {
  console.error(`Refused an Agent API ${what} answer that does not match its request`);
  throw new AgentApiUnavailable(`invalid_${what}_answer`);
}

const answer = (call: Promise<unknown>) => call.catch((error: unknown) => {
  throw error instanceof AgentApiError ? error : new AgentApiUnavailable('agent_api_unavailable', { cause: error });
});

function statusOf(value: unknown, expected: Expected): AgentStatus {
  if (!object(value) || typeof value.correlation_id !== 'string' || !CORRELATION.test(value.correlation_id)
    || typeof value.status !== 'string' || !Object.hasOwn(SETTLED, value.status) || value.type !== expected.type
    || !(value.agent_id === null || value.agent_id === expected.agentId) || !object(value.details)
    || !(value.failure_code === null || typeof value.failure_code === 'string')
    || (expected.correlationId !== undefined && value.correlation_id !== expected.correlationId)
    || (expected.fits && !expected.fits(value.details))) {
    return untrusted('status');
  }
  const code = value.failure_code;
  return { correlation_id: value.correlation_id, type: value.type, status: value.status as Status,
    failure_code: code === null || CODE.test(code) ? code : 'unrecognized_failure', details: value.details };
}

const unset = (value: unknown, want: string) => value === null || value === undefined || value === want;

export function expectedOf(send: Send, agentId: string, agent: string): Expected {
  if ('native' in send) {
    const call = send.native;
    return { type: 'native', agentId, fits: d => d.method === 'near_call' && unset(d.target, call.receiver_id)
      && unset(d.method_name, call.method_name) && unset(d.account_id, agent) };
  }
  const w = send.withdraw;
  return { type: 'withdraw', agentId, fits: d => {
    const asked = object(d.request) ? d.request : {};
    return unset(asked.asset, w.asset) && unset(asked.amount, w.amount) && unset(asked.chain, w.chain)
      && unset(asked.recipient, w.recipient);
  } };
}

function intentOf(value: unknown, type: IntentType, owner: Owner | EvmOwner, agentId?: string): OwnerIntent {
  const signer = object(value) && object(value.signer) ? value.signer : null;
  const expected: OwnerIntent['signer'] = 'type' in owner ? owner
    : { type: 'near', account_id: owner.account, public_key: owner.publicKey };
  if (!object(value) || typeof value.correlation_id !== 'string' || !value.correlation_id.startsWith('intent_')
    || !CORRELATION.test(value.correlation_id) || value.type !== type || typeof value.agent_id !== 'string'
    || !AGENT_ID.test(value.agent_id) || (agentId !== undefined && value.agent_id !== agentId)
    || value.status !== 'PENDING_SIGNATURE' || typeof value.expires_at !== 'string'
    || Number.isNaN(Date.parse(value.expires_at)) || canonical(signer) !== canonical(expected)
    || (expected.type === 'evm' && !isEvmOwner(signer))
    || !object(value.intent) || typeof value.intent.standard !== 'string' || !object(value.intent.payload)
    || !object(value.preview) || typeof value.preview.summary !== 'string') {
    return untrusted('intent');
  }
  return { correlation_id: value.correlation_id, type, agent_id: value.agent_id, status: value.status,
    expires_at: value.expires_at, intent: { standard: value.intent.standard, payload: value.intent.payload },
    signer: { ...expected },
    preview: { ...value.preview, summary: value.preview.summary } };
}

export function readAgentApiSettings(env: NodeJS.ProcessEnv): AgentApiSettings | null {
  const url = env.AGENT_API_URL, key = env.AGENT_API_KEY;
  if (!url && !key) return null;
  if (!url || !key) throw new Error('AGENT_API_URL and AGENT_API_KEY go together');
  let settings: AgentApiSettings;
  try {
    new AgentApiClient({ url, key, timeoutMs: 15000 });
    settings = { url: new URL(url).origin, key, timeoutMs: 15000 };
  } catch {
    throw new Error('AGENT_API_URL must be a plain https origin and AGENT_API_KEY a naa_ key');
  }
  return settings;
}

function policyExpectationError(request: GenerateIntentRequest, expected?: PolicyExpectation) {
  const policy = ['agent_create', 'agent_freeze', 'agent_unfreeze'].includes(request.type);
  if (policy && !expected) return 'policy_approval_required';
  if (request.type === 'agent_create' && expected && canonical(request.policy) !== canonical(expected.policy)) {
    return 'policy_approval_mismatch';
  }
  return null;
}

function policyReadOwner(owner: unknown, generated: OwnerIntent) {
  return (generated.type === 'agent_create' && owner === null) || canonical(owner) === canonical(generated.signer);
}

function policyWalletAccount(agent: unknown, generated: OwnerIntent) {
  if (!object(agent) || agent.id !== generated.agent_id || !object(agent.wallet)
    || typeof agent.wallet.near_account_id !== 'string' || !AGENT_ID.test(agent.wallet.near_account_id)) {
    return untrusted('policy');
  }
  if (!policyReadOwner(agent.owner, generated)) return untrusted('policy');
  return agent.wallet.near_account_id;
}

export class AgentApiClient {
  private readonly api: AgentApi;

  constructor(private readonly settings: AgentApiSettings, fetcher?: typeof fetch) {
    this.api = createAgentApi({ apiKey: settings.key, baseUrl: settings.url, maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: settings.timeoutMs + MAX_WAIT_MS, ...(fetcher ? { fetch: fetcher } : {}) });
  }

  private deadline(waitMs = 0) {
    return AbortSignal.timeout(this.settings.timeoutMs + waitMs);
  }

  async verifyService(expected: { network: string; walletContract: string }): Promise<void> {
    const options = { signal: AbortSignal.timeout(Math.min(this.settings.timeoutMs, 2500)) };
    const [network, identity] = await Promise.all([
      answer(this.api.getNetwork(options)), answer(this.api.whoami(options)),
    ]);
    if (!object(network) || network.network !== 'mainnet' || network.network !== expected.network
      || network.contract_id !== expected.walletContract || !account(network.contract_id)
      || !Array.isArray(network.supported_owner_types) || !network.supported_owner_types.includes('near')) {
      throw new AgentApiUnavailable('agent_api_incompatible');
    }
    const identifier = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
    if (!object(identity) || !identifier(identity.tenant_id) || !identifier(identity.api_key_id)) {
      throw new AgentApiUnavailable('invalid_agent_api_identity');
    }
    // Dependency status is advisory, not evidence of a wallet's policy or an execution outcome.
  }

  forGrant(grant: AgentGrant): GrantCalls {
    if (!AGENT_ID.test(grant.agentId)) throw new Error('invalid_agent_id');
    let api: AgentApi;
    try { api = this.api.forGrant(grant.token); } catch { throw new Error('invalid_grant_token'); }
    return {
      send: (idempotencyKey, send, expected) => {
        const options = { idempotencyKey, signal: this.deadline() };
        return answer('native' in send ? api.nativeNearCall(grant.agentId, send.native, options)
          : api.withdraw(grant.agentId, send.withdraw, options)).then(v => statusOf(v, expected));
      },
    };
  }

  status(correlationId: string, waitMs: number, expected: Expected, refresh = false): Promise<AgentStatus> {
    if (!CORRELATION.test(correlationId)) return Promise.reject(new Error('invalid_correlation_id'));
    const wait = Math.min(Math.max(0, Math.trunc(waitMs)), MAX_WAIT_MS);
    return answer(this.api.getStatus(correlationId, { waitMs: wait, refresh, signal: this.deadline(wait) }))
      .then(v => statusOf(v, { ...expected, correlationId }));
  }

  frozen(agentId: string): Promise<boolean> {
    return this.policy(agentId).then(policy => {
      const frozen = appliedFreeze(policy);
      return frozen === null ? untrusted('policy') : frozen;
    });
  }

  policy(agentId: string): Promise<AccountPolicy> {
    if (!AGENT_ID.test(agentId)) return Promise.reject(new Error('invalid_agent_id'));
    return answer(this.api.getPolicy(agentId, { signal: this.deadline() })).then(v => {
      if (!object(v) || typeof v.status !== 'string' || !['NONE', 'SIGNED', 'APPLIED', 'FAILED'].includes(v.status)
        || typeof v.provider_policy_synced !== 'boolean'
        || !(v.revision === null || (Number.isSafeInteger(v.revision) && (v.revision as number) >= 0))
        || !(v.policy === null || (object(v.policy) && typeof v.policy.frozen === 'boolean'))) {
        return untrusted('policy');
      }
      return { status: v.status as AccountPolicy['status'], revision: v.revision as number | null,
        synced: v.provider_policy_synced, policy: v.policy as AccountPolicy['policy'] };
    });
  }

  policyHistory(agentId: string): Promise<PolicyRevision[]> {
    if (!AGENT_ID.test(agentId)) return Promise.reject(new Error('invalid_agent_id'));
    return answer(this.api.getPolicyHistory(agentId, { limit: 100 }, { signal: this.deadline() })).then(v => {
      if (!object(v) || !Array.isArray(v.data) || v.data.length === 0 || v.data.length > 100) {
        return untrusted('policy');
      }
      let previous = Infinity;
      return v.data.map(entry => {
        if (!object(entry) || !Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1
          || (entry.revision as number) >= previous || typeof entry.status !== 'string'
          || !['SIGNED', 'APPLIED', 'FAILED'].includes(entry.status)
          || !(entry.policy === null || (object(entry.policy) && typeof entry.policy.frozen === 'boolean'))) {
          return untrusted('policy');
        }
        previous = entry.revision as number;
        return { revision: previous, status: entry.status as PolicyRevision['status'],
          policy: entry.policy as PolicyRevision['policy'] };
      });
    });
  }

  wallet(agentId: string): Promise<{ near_account_id: string }> {
    if (!AGENT_ID.test(agentId)) return Promise.reject(new Error('invalid_agent_id'));
    return answer(this.api.getWallet(agentId, { signal: this.deadline() })).then(v => {
      if (!object(v) || !account(v.near_account_id)) return untrusted('wallet');
      return { near_account_id: v.near_account_id as string };
    });
  }

  generateIntent(request: GenerateIntentRequest, owner: Owner | EvmOwner, idempotencyKey: string,
    expectation?: PolicyExpectation): Promise<OwnerIntent> {
    request = structuredClone(request);
    owner = { ...owner };
    expectation = expectation ? structuredClone(expectation) : undefined;
    const error = policyExpectationError(request, expectation);
    if (error) return Promise.reject(new AgentApiUnavailable(error));
    const agentId = 'agent_id' in request ? request.agent_id : undefined;
    return answer(this.api.generateIntent(request, { idempotencyKey, signal: this.deadline() }))
      .then(v => {
        const generated = intentOf(v, request.type, owner, agentId);
        return expectation ? this.policyIntent(generated, expectation) : generated;
      });
  }

  private async policyIntent(generated: OwnerIntent, expectation: PolicyExpectation): Promise<OwnerIntent> {
    const [agent, identity] = await Promise.all([
      answer(this.api.getAgent(generated.agent_id, { signal: this.deadline() })),
      answer(this.api.whoami({ signal: this.deadline() }))]);
    const walletAccount = policyWalletAccount(agent, generated);
    if (!object(identity) || typeof identity.tenant_id !== 'string') return untrusted('policy');
    if (expectation.walletAccount !== undefined && expectation.walletAccount !== walletAccount) return untrusted('policy');
    const approval: PolicyApproval = { tenantId: identity.tenant_id, walletAccount,
      walletContract: expectation.walletContract, revision: expectation.revision,
      policy: expectation.policy, storageRefundTo: expectation.storageRefundTo };
    const valid = generated.signer.type === 'near'
      ? nearPolicyRequest(generated, approval.walletContract, approval)
      : evmPolicyRequest(generated, approval.walletContract, approval);
    if (!valid) return untrusted('policy');
    return { ...generated, policy_approval: approval };
  }

  submitIntent(intent: Pick<OwnerIntent, 'type' | 'correlation_id' | 'agent_id'>, signed: Record<string, unknown>) {
    const request = { type: intent.type, correlation_id: intent.correlation_id, signed_data: signed as SignedData };
    return answer(this.api.submitIntent(request, { signal: this.deadline() }))
      .then(v => statusOf(v, { type: intent.type, agentId: intent.agent_id, correlationId: intent.correlation_id }));
  }
}
