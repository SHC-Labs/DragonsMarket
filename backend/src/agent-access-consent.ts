import type { Config } from './config.js';

export const ACCESS_SIGNING_MS = 5 * 60 * 1000;
export const ACCESS_LIFETIME_MS = 30 * 24 * 3600 * 1000;

export interface AccessConsent {
  id: string;
  owner: string;
  agentId: string;
  label: string;
  maxSpend: string;
  dailyLimit: string;
  expiresAt: string;
  signBefore: string;
}

export function accessMessage(config: { network: Config['network']; token: string; origin: string },
  terms: AccessConsent) {
  return ['Authorize a Dragons Market MCP connection (v1)', `Request: ${terms.id}`,
    `Site: ${config.origin}`, `Network: ${config.network}`, `Owner: ${terms.owner}`, `Agent: ${terms.agentId}`,
    `Name: ${terms.label}`, `Collateral: ${config.token}`,
    `Maximum per buy or stake (atomic units): ${terms.maxSpend}`,
    `Maximum per rolling 24 hours (atomic units): ${terms.dailyLimit}`,
    'Allowed actions: stake, claim, buy, sell, redeem, withdraw, cash_out.',
    'Withdrawals return to the agent balance. Cash-out pays only the owner.',
    'This connection cannot change account policy, grant access or mint NFTs.',
    `Access expires: ${terms.expiresAt}`, `Sign before: ${terms.signBefore}`].join('\n');
}
