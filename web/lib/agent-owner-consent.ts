import type { OwnerIntent } from "./agents";
import { config } from "./config";
import { evmConsent, isEvmOwner } from "./agent-evm-consent";

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const HEX = /^[0-9a-f]{64}$/;
const WINDOW_MS = 15 * 60 * 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parseConsent(text: unknown) {
  if (typeof text !== "string" || text.length > 16384) return null;
  try {
    const value: unknown = JSON.parse(text);
    return record(value) && canonical(value) === text ? value : null;
  } catch { return null; }
}

export function ownerConsentMatches(generated: OwnerIntent, now = Date.now()) {
  const { standard, payload } = generated.intent;
  const evm = standard === "eip712" && isEvmOwner(generated.signer) && config.network === "mainnet";
  if (!evm && (standard !== "nep413" || generated.signer?.type !== "near")) return false;
  const message = parseConsent(evm ? evmConsent(payload, config.agentApiHost)?.message.payload : payload.message);
  const deadline = Date.parse(generated.expires_at);
  if (!message || !positive(message.issued_at_ms) || !positive(message.expires_at_ms)
    || !positive(message.owner_epoch) || typeof message.nonce !== "string" || !HEX.test(message.nonce)) return false;
  const nonce = btoa(String.fromCharCode(...message.nonce.match(/../g)!.map(byte => parseInt(byte, 16))));
  if (canonical(message.owner) !== canonical(generated.signer) || message.agent_id !== generated.agent_id
    || message.network !== config.network || message.recipient !== config.agentApiHost
    || (!evm && nonce !== payload.nonce)
    || typeof message.tenant_id !== "string" || !message.tenant_id.length || message.tenant_id.length > 64
    || message.issued_at_ms > now + 60000 || message.issued_at_ms <= now - WINDOW_MS
    || !(deadline > now && deadline > message.issued_at_ms && deadline <= message.issued_at_ms + WINDOW_MS)
    || message.expires_at_ms < deadline) return false;
  const common = ["domain", "owner", "tenant_id", "agent_id", "network", "issued_at_ms", "expires_at_ms",
    "owner_epoch", "nonce", "recipient"];
  if (generated.type === "grant_issue") {
    return message.domain === "near-intents-agent-api.agent-grant.v6" && message.label === "Dragons Market"
      && typeof message.credential === "string" && HEX.test(message.credential)
      && typeof message.wallet_id === "string" && message.wallet_id.length > 0 && message.wallet_id.length <= 256
      && message.expires_at_ms - message.issued_at_ms <= 90 * 86400000
      && Object.keys(message).every(key => [...common, "wallet_id", "label", "credential"].includes(key));
  }
  return generated.type === "grant_revoke" && message.domain === "near-intents-agent-api.owner-admin.v2"
    && message.action === "revoke_grant" && typeof message.target_id === "string"
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(message.target_id)
    && message.expires_at_ms - message.issued_at_ms <= WINDOW_MS
    && Object.keys(message).every(key => [...common, "action", "target_id"].includes(key));
}
