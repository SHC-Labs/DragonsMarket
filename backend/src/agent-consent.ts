import type { GenerateIntentRequest } from '@near-intents-agent-api/sdk';
import { canonical, object } from './ingestion/block.js';
import type { OwnerIntent } from './agent-api.js';
import type { OwnerSigning } from './agent-policy.js';
import type { Owner } from './agent-paths.js';
import { evmConsent, isEvmOwner, type EvmOwner } from './agent-evm-consent.js';

const SIGNING_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60000;
const HEX = /^[0-9a-f]{64}$/;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
interface ConsentEnvelope extends Record<string, unknown> { issued_at_ms: number; expires_at_ms: number }

export function consentText(intent: OwnerIntent, recipient: string): string | null {
  const { standard, payload } = intent.intent;
  if (standard === 'eip712' && intent.signer?.type === 'evm') {
    return evmConsent(payload, recipient)?.message.payload ?? null;
  }
  return standard === 'nep413' && (!intent.signer || intent.signer.type === 'near')
    && typeof payload.message === 'string'
    && payload.message.length <= 16384 ? payload.message : null;
}

function messageOf(intent: OwnerIntent, recipient: string) {
  const text = consentText(intent, recipient);
  if (text === null) return null;
  try {
    const message: unknown = JSON.parse(text);
    return object(message) && canonical(message) === text ? message : null;
  } catch { return null; }
}

function boundMessage(signing: OwnerSigning, intent: OwnerIntent, owner: Owner | EvmOwner,
  message: Record<string, unknown>): message is ConsentEnvelope {
  const now = Date.now(), signingDeadline = Date.parse(intent.expires_at);
  if (!positive(message.issued_at_ms) || !positive(message.expires_at_ms) || !positive(message.owner_epoch)) return false;
  const lifetime = signingDeadline - message.issued_at_ms;
  const identity = 'type' in owner ? owner : { type: 'near', account_id: owner.account, public_key: owner.publicKey };
  if (identity.type === 'evm' && (!isEvmOwner(identity) || signing.network !== 'mainnet')) return false;
  return message.agent_id === intent.agent_id && message.network === signing.network
    && message.recipient === signing.messageRecipient
    && canonical(message.owner) === canonical(identity) && canonical(intent.signer) === canonical(identity)
    && typeof message.tenant_id === 'string' && message.tenant_id.length > 0 && message.tenant_id.length <= 64
    && typeof message.nonce === 'string' && HEX.test(message.nonce)
    && (identity.type === 'evm'
      || Buffer.from(message.nonce, 'hex').toString('base64') === intent.intent.payload.nonce)
    && message.issued_at_ms <= now + CLOCK_SKEW_MS && message.issued_at_ms > now - SIGNING_MS
    && signingDeadline > now && lifetime > 0 && lifetime <= SIGNING_MS
    && message.expires_at_ms >= signingDeadline;
}

export function consentMatches(signing: OwnerSigning, intent: OwnerIntent, request: GenerateIntentRequest,
  owner: Owner | EvmOwner) {
  if (request.type !== 'grant_issue' && request.type !== 'grant_revoke') return true;
  if (intent.type !== request.type || intent.agent_id !== request.agent_id) return false;
  const message = messageOf(intent, signing.messageRecipient);
  if (!message || !boundMessage(signing, intent, owner, message)) return false;
  const common = ['domain', 'owner', 'tenant_id', 'agent_id', 'network', 'issued_at_ms', 'expires_at_ms',
    'owner_epoch', 'nonce', 'recipient'];
  if (request.type === 'grant_issue') {
    return message.domain === 'near-intents-agent-api.agent-grant.v6'
      && message.credential === request.credential && message.label === request.label
      && message.expires_at_ms === Date.parse(request.expires_at)
      && typeof message.wallet_id === 'string' && message.wallet_id.length > 0 && message.wallet_id.length <= 256
      && Object.keys(message).every(key => [...common, 'wallet_id', 'label', 'credential'].includes(key));
  }
  return message.domain === 'near-intents-agent-api.owner-admin.v2' && message.action === 'revoke_grant'
    && message.target_id === request.grant_id
    && message.expires_at_ms - message.issued_at_ms <= SIGNING_MS
    && Object.keys(message).every(key => [...common, 'action', 'target_id'].includes(key));
}
