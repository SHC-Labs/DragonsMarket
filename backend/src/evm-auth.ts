import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getAddress, hashMessage, recoverPublicKey, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { Config } from './config.js';
import { checkChallengeCapacity, completeLogin, isUuid, tokenHash } from './auth.js';

export const EVM_LOGIN_STATEMENT =
  'Sign in to Dragons Market. This creates a website session. It does not authorize transactions.';

function evmIdentity(address: string, chainId: number) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('invalid_evm_account');
  }
  const normalized = getAddress(address);
  return { address: normalized, account: `eip155:${chainId}:${normalized.toLowerCase()}` };
}

export async function evmChallenge(pool: pg.Pool, config: Config, address: string, chainId: number) {
  const owner = evmIdentity(address, chainId);
  await checkChallengeCapacity(pool);
  const id = randomUUID();
  const nonce = randomBytes(32).toString('hex');
  const browser = randomBytes(32).toString('base64url');
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 300000);
  const origin = new URL(config.webOrigin);
  const message = createSiweMessage({
    address: owner.address, chainId, scheme: origin.protocol.slice(0, -1), domain: origin.host,
    uri: config.webOrigin, version: '1', nonce, issuedAt, expirationTime: expiresAt,
    requestId: id, statement: EVM_LOGIN_STATEMENT,
  });
  await pool.query(`INSERT INTO wallet_challenges
    (id,account_id,network,origin,nonce,browser_hash,message,expires_at,wallet_type,evm_chain_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'evm',$9)`, [
    id, owner.account, config.network, config.webOrigin, nonce, tokenHash(browser), message, expiresAt, chainId,
  ]);
  return { browser, request: {
    id, address: owner.address, chainId, message, expiresAt: expiresAt.toISOString(),
  } };
}

async function recoverOwner(message: string, signature: Hex, account: string, chainId: number) {
  try {
    const key = await recoverPublicKey({ hash: hashMessage(message), signature });
    const address = publicKeyToAddress(key);
    if (evmIdentity(address, chainId).account !== account) return null;
    return `0x${key.slice(4).toLowerCase()}`;
  } catch {
    return null;
  }
}

export async function evmLogin(
  pool: pg.Pool,
  config: Config,
  proof: { id: string; signature: string; browser: string },
) {
  if (!isUuid(proof.id) || !/^[A-Za-z0-9_-]{43}$/.test(proof.browser)) throw new Error('invalid_login');
  const row = (await pool.query(`SELECT account_id,evm_chain_id,origin,network,browser_hash,message
    FROM wallet_challenges WHERE id=$1 AND wallet_type='evm' AND consumed_at IS NULL AND expires_at>now()`,
  [proof.id])).rows[0];
  if (!row || row.origin !== config.webOrigin || row.network !== config.network ||
      row.browser_hash !== tokenHash(proof.browser)) throw new Error('invalid_login');
  const signature = /^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(proof.signature)
    ? proof.signature as Hex : null;
  const publicKey = signature
    ? await recoverOwner(row.message, signature, row.account_id, Number(row.evm_chain_id)) : null;
  if (!publicKey) {
    await pool.query('UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL', [proof.id]);
    throw new Error('invalid_login');
  }
  return completeLogin(pool, config, { id: proof.id, publicKey, walletType: 'evm' });
}
