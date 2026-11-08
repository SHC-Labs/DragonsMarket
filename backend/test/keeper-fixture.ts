import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { base58Encode } from '../src/base58.js';
import { readConfig } from '../src/config.js';
import type { KeeperApproval } from '../src/keeper-approval.js';

export function keeperFixture() {
  const config = readConfig({ DATABASE_URL: 'postgres://localhost/test', NETWORK: 'mainnet',
    DEPLOYMENT_ID: 'keeper-fixture', DEPLOYMENT_START_BLOCK: '100', MARKET_CONTRACT_ID: 'market.near',
    ORACLE_CONTRACT_ID: 'oracle.near', COUNCIL_CONTRACT_ID: 'council.near', ROUNDS_CONTRACT_ID: 'rounds.near',
    VERIFIER_CONTRACT_ID: 'intents.near', COLLATERAL_TOKEN_ID: 'nep141:usdc.near',
    RPC_URL: 'https://first.invalid', RPC_SECOND_URL: 'https://second.invalid' });
  const env: NodeJS.ProcessEnv = {};
  const publicKeys = {} as KeeperApproval['keeper']['publicKeys'];
  for (const [index, role] of (['market', 'oracle', 'council'] as const).entries()) {
    const seed = Buffer.alloc(32, index + 1);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
    publicKeys[role] = `ed25519:${base58Encode(publicKey)}`;
    env[`KEEPER_${role.toUpperCase()}_KEY`] = `ed25519:${base58Encode(Buffer.concat([seed, publicKey]))}`;
  }
  const approval: KeeperApproval = {
    version: 1, network: 'mainnet', deployment: config.deployment!, approvedBy: 'test-reviewer',
    approvedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    reviewEvidence: 'https://review.invalid/keeper', marketIds: ['0'], contracts: {},
    controls: { owner: 'owner.near', operator: 'operator.near', treasury: 'treasury.near' },
    keeper: { accountId: 'keeper.near', publicKeys, minBalanceYocto: '1000', maxKeyAllowanceYocto: '10000',
      maxActionsPerRun: 10, maxGasPerRunTgas: 1000 },
  };
  for (const [role, accountId] of Object.entries({ ...approval.deployment.contracts, nft: 'nft.near', collateral: 'usdc.near' })) {
    approval.contracts[role as keyof KeeperApproval['contracts']] = {
      accountId, codeHash: base58Encode(createHash('sha256').update(role).digest()),
      sourceCommit: 'a'.repeat(40), buildEvidence: `https://build.invalid/${role}`,
    };
  }
  const encode = (value: unknown = approval) => {
    const raw = JSON.stringify(value);
    return { KEEPER_APPROVAL_JSON: raw, KEEPER_APPROVAL_SHA256: createHash('sha256').update(raw).digest('hex') };
  };
  return { config, approval, env, encode };
}
