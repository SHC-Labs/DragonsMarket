import { publicKeyToAddress } from 'viem/accounts';
import { hashTypedData, recoverPublicKey, type Hex, type TypedData } from 'viem';
import { canonical, object } from './ingestion/block.js';
import type { EvmPolicyMessage } from './agent-evm-policy.js';

export interface EvmOwner { type: 'evm'; address: string; chain_id: number; public_key: string }

const TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
  Authorization: [{ name: 'purpose', type: 'string' }, { name: 'recipient', type: 'string' },
    { name: 'payload', type: 'string' }],
} as const;
const DOMAIN = { name: 'NEAR Wallet Contract', version: '1' } as const;
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const hex = (value: unknown, digits: number): value is Hex => typeof value === 'string'
  && value.length === digits + 2 && /^0x[0-9a-f]+$/.test(value);
const chain = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const signatureBytes = (value: unknown): value is Hex => typeof value === 'string'
  && /^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(value)
  && BigInt(`0x${value.slice(66, 130)}`) <= HALF_ORDER;

export function isEvmOwner(value: unknown): value is EvmOwner {
  if (!object(value) || value.type !== 'evm' || !only(value, ['type', 'address', 'chain_id', 'public_key'])) return false;
  if (!hex(value.address, 40) || !hex(value.public_key, 128) || !chain(value.chain_id)) return false;
  return publicKeyToAddress(`0x04${value.public_key.slice(2)}`).toLowerCase() === value.address;
}

function authorizationMessage(message: unknown, recipient: string) {
  if (!object(message) || message.purpose !== 'PROVE_OWNERSHIP' || message.recipient !== recipient
    || !only(message, ['purpose', 'recipient', 'payload'])) return null;
  if (typeof message.payload !== 'string' || message.payload.length > 16384) return null;
  return { purpose: 'PROVE_OWNERSHIP', recipient, payload: message.payload };
}

export function evmConsent(payload: Record<string, unknown>, recipient: string) {
  if (!recipient || payload.primaryType !== 'Authorization' || canonical(payload.types) !== canonical(TYPES)
    || canonical(payload.domain) !== canonical(DOMAIN)
    || !only(payload, ['domain', 'types', 'primaryType', 'message'])) return null;
  const message = authorizationMessage(payload.message, recipient);
  return message ? { domain: DOMAIN, types: TYPES, primaryType: 'Authorization' as const, message } : null;
}

export function verifyEvmConsent(owner: EvmOwner, payload: Record<string, unknown>, signature: unknown) {
  const recipient = object(payload.message) ? payload.message.recipient : null;
  const typed = typeof recipient === 'string' ? evmConsent(payload, recipient) : null;
  return typed ? verifyEvmSignature(owner, typed, signature) : Promise.resolve(false);
}

export async function verifyEvmSignature(owner: EvmOwner,
  typed: NonNullable<ReturnType<typeof evmConsent>> | EvmPolicyMessage, signature: unknown) {
  if (!isEvmOwner(owner) || !signatureBytes(signature)) return false;
  try {
    const key = await recoverPublicKey({ hash: hashTypedData<TypedData, string>(typed), signature });
    return `0x${key.slice(4).toLowerCase()}` === owner.public_key;
  } catch { return false; }
}
