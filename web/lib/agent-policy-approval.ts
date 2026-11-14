import { sha256, stringToHex } from "viem";
import type { OwnerIntent } from "./agents";
export const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}`;
  return JSON.stringify(v);
}

export interface PolicyApproval {
  tenantId: string;
  walletContract: string;
  walletAccount: string;
  revision: number;
  policy: Record<string, unknown>;
  storageRefundTo: string | null;
}
export type PolicyExpectation = Omit<PolicyApproval, "tenantId" | "walletAccount"> & { walletAccount?: string };

const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const hex = (v: unknown, size: number) => typeof v === "string" && v.length === size && /^[0-9a-f]+$/.test(v);
const hash = (v: unknown) => sha256(stringToHex(canonical(v))).slice(2);

export function approvalMatches(g: OwnerIntent, a: PolicyApproval) {
  if (!object(a) || !hex(a.walletAccount, 64) || !positive(a.revision) || !object(a.policy)
    || typeof a.tenantId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(a.tenantId)) return false;
  const preview = g.preview;
  if (preview.revision !== a.revision || preview.previous_revision !== a.revision - 1
    || preview.policy_hash !== hash(a.policy) || canonical(preview.policy) !== canonical(a.policy)) return false;
  if (g.type === "agent_create") return a.revision === 1 && a.policy.frozen === false;
  return ["agent_freeze", "agent_unfreeze"].includes(g.type)
    && a.revision > 1 && a.policy.frozen === (g.type === "agent_freeze") && a.storageRefundTo === null;
}

function encoded(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32768) return false;
  try { return btoa(atob(value)) === value; } catch { return false; }
}

export function storeMatches(args: Record<string, unknown>, g: OwnerIntent, a: PolicyApproval) {
  const keys = ["wallet_pubkey", "encrypted_data", "wallet_signature", "version", "locked",
    "valid_until", "agent_policy_hash", ...(g.type === "agent_create" ? ["storage_refund_to"] : [])];
  if (!only(args, keys) || args.wallet_pubkey !== `ed25519:${a.walletAccount}` || args.locked !== false) return false;
  if (!positive(args.version) || !positive(args.valid_until)
    || args.valid_until < Math.ceil(Date.parse(g.expires_at) / 1000)
    || !hex(args.wallet_signature, 128) || !encoded(args.encrypted_data)) return false;
  const commitment = hash({ domain: "near-intents-agent-api.policy.v1", tenantId: a.tenantId,
    agentId: g.agent_id, revision: a.revision, policy: a.policy });
  return args.agent_policy_hash === commitment && (args.storage_refund_to ?? null) === a.storageRefundTo;
}
