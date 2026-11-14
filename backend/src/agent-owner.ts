import { decodeKey } from './auth.js';
import { isEvmOwner } from './agent-evm-consent.js';
import { agentPath, intentPath, tokenPath, type AgentOwner, type EvmAgentOwner, type Owner } from './agent-paths.js';
import { object } from './ingestion/block.js';
import { ReadError } from './read-api.js';
import { isAccount } from './validate.js';

const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every(key => keys.includes(key));

function evmAgentOwner(value: Record<string, unknown>): EvmAgentOwner {
  const signer = value.signer;
  if (!only(value, ['type', 'account', 'signer']) || !isEvmOwner(signer)
    || value.account !== `eip155:${signer.chain_id}:${signer.address}`) {
    throw new ReadError(400, 'invalid_owner');
  }
  return { type: 'evm', account: value.account, signer: { ...signer } };
}

export function agentOwner(value: unknown): AgentOwner {
  if (!object(value)) throw new ReadError(400, 'invalid_owner');
  if (value.type === 'evm') return evmAgentOwner(value);
  if (!only(value, ['account', 'publicKey']) || !isAccount(value.account)
    || typeof value.publicKey !== 'string') throw new ReadError(400, 'invalid_owner');
  try { decodeKey(value.publicKey); } catch { throw new ReadError(400, 'invalid_owner'); }
  return { account: value.account, publicKey: value.publicKey };
}

export function sessionAgentOwner(identity: Record<string, unknown>): AgentOwner {
  if (identity.wallet_type === 'near' && identity.evm_chain_id === null) {
    return agentOwner({ account: identity.account_id, publicKey: identity.public_key });
  }
  if (identity.wallet_type !== 'evm' || typeof identity.account_id !== 'string'
    || typeof identity.evm_chain_id !== 'string') throw new ReadError(401, 'invalid_session_identity');
  const chainId = Number(identity.evm_chain_id);
  if (String(chainId) !== identity.evm_chain_id) throw new ReadError(401, 'invalid_session_identity');
  return agentOwner({ type: 'evm', account: identity.account_id, signer: {
    type: 'evm', address: identity.account_id.split(':')[2],
    chain_id: chainId, public_key: identity.public_key,
  } });
}

export function nearOwner(owner: AgentOwner): Owner {
  if ('signer' in owner) throw new ReadError(409, 'agent_owner_wallet_not_supported');
  return owner;
}

export const providerOwner = (owner: AgentOwner) => 'signer' in owner ? owner.signer : owner;

const inspection = (path: string) => path === '/v1/agents'
  || ['operations', 'claimable', 'access'].includes(agentPath.exec(path)?.[2] ?? '');
const revocation = (path: string) => agentPath.exec(path)?.[2] === 'revoke'
  || tokenPath.exec(path)?.[3] === 'revoke' || intentPath.test(path);

export function allowOwnerRoute(owner: AgentOwner, method: string, path: string) {
  if (!('signer' in owner)) return;
  if (method === 'GET' && inspection(path)) return;
  if (method === 'POST' && revocation(path)) return;
  throw new ReadError(409, 'agent_owner_wallet_not_supported');
}
