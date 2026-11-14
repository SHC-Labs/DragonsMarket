import { config } from "./config";

export interface AccessTerms {
  agentId: string;
  label: string;
  maxSpend: string;
  dailyLimit: string;
}
export interface AccessRequest {
  id: string;
  message: string;
  nonce: string;
  recipient: string;
  expires_at: string;
  sign_before: string;
  terms: AccessTerms;
}

const SIGNING_MS = 5 * 60 * 1000;
const LIFETIME_MS = 30 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNITS = /^(?:0|[1-9][0-9]{0,38})$/;
const LABEL = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;

function message(asked: AccessRequest, owner: string, origin: string) {
  const { terms } = asked;
  return ["Authorize a Dragons Market MCP connection (v1)", `Request: ${asked.id}`,
    `Site: ${origin}`, `Network: ${config.network}`, `Owner: ${owner}`, `Agent: ${terms.agentId}`,
    `Name: ${terms.label}`, `Collateral: ${config.collateralTokenId}`,
    `Maximum per buy or stake (atomic units): ${terms.maxSpend}`,
    `Maximum per rolling 24 hours (atomic units): ${terms.dailyLimit}`,
    "Allowed actions: stake, claim, buy, sell, redeem, withdraw, cash_out.",
    "Withdrawals return to the agent balance. Cash-out pays only the owner.",
    "This connection cannot change account policy, grant access or mint NFTs.",
    `Access expires: ${asked.expires_at}`, `Sign before: ${asked.sign_before}`].join("\n");
}

export function accessConsentMatches(asked: AccessRequest, agentId: string, owner: string,
  origin: string | undefined, now = Date.now()) {
  const { terms } = asked;
  if (!origin || asked.recipient !== origin || !UUID.test(asked.id)
    || !/^[A-Za-z0-9+/]{43}=$/.test(asked.nonce) || !terms || terms.agentId !== agentId
    || !/^[0-9a-f]{64}$/.test(agentId) || !LABEL.test(terms.label)
    || !UNITS.test(terms.maxSpend) || !UNITS.test(terms.dailyLimit)) return false;
  const signBefore = Date.parse(asked.sign_before), expiresAt = Date.parse(asked.expires_at);
  return BigInt(terms.maxSpend) > 0n && BigInt(terms.dailyLimit) >= BigInt(terms.maxSpend)
    && signBefore > now && signBefore <= now + SIGNING_MS + 60000
    && expiresAt - signBefore === LIFETIME_MS - SIGNING_MS
    && asked.message === message(asked, owner, origin);
}
