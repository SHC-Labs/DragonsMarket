import type pg from 'pg';
import type { Config } from './config.js';
import { challenge, login, type CheckAccessKey } from './auth.js';
import { evmChallenge, evmLogin } from './evm-auth.js';
import { isAccount } from './validate.js';
import { ReadError } from './read-api.js';

const LOGIN_REJECTIONS = ['invalid_login', 'challenge_used_or_expired', 'invalid_public_key', 'invalid_nonce'];
export const isAuthChallenge = (path: string) =>
  path === '/v1/auth/challenge' || path === '/v1/auth/evm/challenge';
export const isAuthVerify = (path: string) =>
  path === '/v1/auth/verify' || path === '/v1/auth/evm/verify';

export async function challengeFor(pool: pg.Pool, config: Config, path: string, body: Record<string, unknown>) {
  try {
    if (path === '/v1/auth/evm/challenge') {
      if (typeof body.address !== 'string' || typeof body.chainId !== 'number') {
        throw new ReadError(400, 'account_required');
      }
      return await evmChallenge(pool, config, body.address, body.chainId);
    }
    if (path !== '/v1/auth/challenge') throw new ReadError(404, 'not_found');
    if (!isAccount(body.accountId)) throw new ReadError(400, 'account_required');
    return await challenge(pool, config, body.accountId);
  } catch (error) {
    if (error instanceof Error && ['invalid_account', 'invalid_evm_account'].includes(error.message)) {
      throw new ReadError(400, error.message);
    }
    if (error instanceof Error && error.message === 'challenge_capacity') {
      throw new ReadError(503, 'challenge_capacity');
    }
    throw error;
  }
}

export async function verifyLogin(
  pool: pg.Pool,
  config: Config,
  request: { path: string; body: Record<string, unknown>; browser: string },
  checkKey: CheckAccessKey,
) {
  const { path, body, browser } = request;
  if (typeof body.id !== 'string' || typeof body.signature !== 'string') {
    throw new ReadError(400, 'invalid_login');
  }
  if (path === '/v1/auth/verify' && typeof body.publicKey !== 'string') {
    throw new ReadError(400, 'invalid_login');
  }
  try {
    if (path === '/v1/auth/evm/verify') {
      return await evmLogin(pool, config, { id: body.id, signature: body.signature, browser });
    }
    if (path !== '/v1/auth/verify' || typeof body.publicKey !== 'string') {
      throw new Error('invalid_login');
    }
    return await login(pool, config, body.id, body.publicKey, body.signature, browser, checkKey);
  } catch (error) {
    throw error instanceof Error && LOGIN_REJECTIONS.includes(error.message)
      ? new ReadError(401, 'login_rejected') : new ReadError(503, 'login_unavailable');
  }
}
