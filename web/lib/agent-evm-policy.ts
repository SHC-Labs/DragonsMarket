import { concat, hexToBytes, keccak256, toBytes } from "viem";
import type { OwnerIntent } from "./agents";
import { isEvmOwner } from "./agent-evm-consent";
import { approvalMatches, canonical, object, storeMatches, type PolicyApproval as EvmPolicyApproval }
  from "./agent-policy-approval";
export type { PolicyApproval as EvmPolicyApproval, PolicyExpectation as EvmPolicyExpectation }
  from "./agent-policy-approval";

const DOMAIN = { name: "NEAR Wallet Contract", version: "1" } as const;
const TYPES = {
  EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }],
  WalletMessage: [
    { name: "chainId", type: "string" }, { name: "signerId", type: "string" },
    { name: "nonce", type: "uint32" }, { name: "createdAt", type: "string" },
    { name: "timeoutSecs", type: "uint32" }, { name: "ops", type: "string" }, { name: "out", type: "string" },
  ],
} as const;
export interface EvmPolicyMessage {
  domain: typeof DOMAIN;
  types: typeof TYPES;
  primaryType: "WalletMessage";
  message: {
    chainId: string; signerId: string; nonce: number; createdAt: string;
    timeoutSecs: number; ops: string; out: string;
  };
}

const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const account = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64
  && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const hex = (v: unknown, size: number) => typeof v === "string" && v.length === size && /^[0-9a-f]+$/.test(v);

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function evmAuthorityAccount(publicKey: string) {
  if (!/^0x[0-9a-f]{128}$/.test(publicKey)) throw new Error("invalid_evm_public_key");
  const code = toBytes("eip712-wallet-contract.trezu.near");
  const state = concat([new Uint8Array([1]), u32(0), hexToBytes(publicKey as `0x${string}`),
    u32(3600), u32(0), u32(0), u32(0), u32(0)]);
  const init = concat([new Uint8Array([0, 1]), u32(code.length), code, u32(1), u32(0), u32(state.length), state]);
  return `0s${keccak256(init).slice(-40)}`;
}

function json(text: unknown, maximum: number) {
  if (typeof text !== "string" || text.length > maximum) return null;
  try {
    const value: unknown = JSON.parse(text);
    return object(value) && JSON.stringify(value) === text ? value : null;
  } catch { return null; }
}

function argsOf(encoded: unknown) {
  if (typeof encoded !== "string" || encoded.length > 32768) return null;
  try {
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) return null;
    return json(new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(binary, char => char.charCodeAt(0))), 24576);
  } catch { return null; }
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value.replace("Z", ".000Z");
}

function messageHeader(v: Record<string, unknown>) {
  return Number.isInteger(v.nonce) && (v.nonce as number) >= 0 && (v.nonce as number) <= 0xffffffff
    && positive(v.timeoutSecs) && v.timeoutSecs <= 600 && timestamp(v.createdAt);
}

function messageContents(v: Record<string, unknown>) {
  return v.chainId === "mainnet" && typeof v.signerId === "string" && v.ops === "[]"
    && typeof v.out === "string" && v.out.length <= 50000
    && only(v, ["chainId", "signerId", "nonce", "createdAt", "timeoutSecs", "ops", "out"]);
}

function messageOf(value: unknown, expiresAt: string, now: number): EvmPolicyMessage["message"] | null {
  if (!object(value) || !messageHeader(value) || !messageContents(value)) return null;
  const message = value as EvmPolicyMessage["message"];
  const start = Date.parse(message.createdAt), end = start + message.timeoutSecs * 1000;
  const deadline = Date.parse(expiresAt);
  return start <= now + 30000 && end > now && deadline > now && deadline <= end ? message : null;
}

function callBudget(value: Record<string, unknown>) {
  return typeof value.deposit === "string" && /^(0|[1-9]\d{0,24})$/.test(value.deposit)
    && typeof value.min_gas === "string" && /^[1-9]\d{0,14}$/.test(value.min_gas);
}

function callOf(value: unknown) {
  if (!object(value) || value.action !== "function_call"
    || !only(value, ["action", "function_name", "args", "deposit", "min_gas"])) return null;
  if (!callBudget(value)) return null;
  const args = argsOf(value.args);
  return args ? { method: value.function_name, args,
    deposit: BigInt(value.deposit as string), gas: BigInt(value.min_gas as string) } : null;
}

function promiseCalls(promise: unknown, contract: string) {
  return object(promise) && only(promise, ["receiver_id", "actions"]) && promise.receiver_id === contract
    && Array.isArray(promise.actions) ? promise.actions as unknown[] : null;
}

function callsOf(out: Record<string, unknown>, contract: string) {
  if (!only(out, ["after", "then"]) || canonical(out.after) !== "[]"
    || !Array.isArray(out.then) || out.then.length !== 1) return null;
  return promiseCalls(out.then[0], contract);
}

function callMatches(call: NonNullable<ReturnType<typeof callOf>>, g: OwnerIntent, a: EvmPolicyApproval, index: number) {
  if (call.deposit > 10n ** 24n) return false;
  if (index === 0) return call.method === "store_wallet_policy"
    && storeMatches(call.args, g, a);
  return call.method === (g.type === "agent_freeze" ? "freeze_wallet" : "unfreeze_wallet")
    && call.deposit === 0n && canonical(call.args) === canonical({ wallet_pubkey: `ed25519:${a.walletAccount}` });
}

function callsMatch(message: EvmPolicyMessage["message"], g: OwnerIntent, a: EvmPolicyApproval, contract: string) {
  const out = json(message.out, 50000), actions = out ? callsOf(out, contract) : null;
  if (!actions || actions.length !== (g.type === "agent_create" ? 1 : 2)) return false;
  let gas = 0n;
  for (const [index, value] of actions.entries()) {
    const call = callOf(value);
    if (!call || !callMatches(call, g, a, index)) return false;
    gas += call.gas;
  }
  return gas <= 100_000_000_000_000n;
}

function policyIdentity(g: OwnerIntent, a: EvmPolicyApproval, contract: string) {
  return a.walletContract === contract && account(contract) && isEvmOwner(g.signer)
    && g.intent.standard === "eip712" && hex(g.agent_id, 64)
    && (a.storageRefundTo === null || account(a.storageRefundTo));
}

function policyFrame(payload: Record<string, unknown>) {
  return payload.primaryType === "WalletMessage" && canonical(payload.domain) === canonical(DOMAIN)
    && canonical(payload.types) === canonical(TYPES) && only(payload, ["domain", "types", "primaryType", "message"]);
}

export function evmPolicyRequest(
  g: OwnerIntent, walletContract: string, approval: EvmPolicyApproval | undefined, now = Date.now(),
): EvmPolicyMessage | null {
  if (!approval || !policyIdentity(g, approval, walletContract) || !approvalMatches(g, approval)) return null;
  if (!policyFrame(g.intent.payload)) return null;
  const message = messageOf(g.intent.payload.message, g.expires_at, now);
  if (!message || message.signerId !== evmAuthorityAccount(g.signer.public_key)
    || !callsMatch(message, g, approval, walletContract)) return null;
  return { domain: DOMAIN, types: TYPES, primaryType: "WalletMessage", message };
}
