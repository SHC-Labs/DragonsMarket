import { hashTypedData, recoverPublicKey, type Hex, type TypedData, type TypedDataDefinition } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { EvmPolicyMessage } from "./agent-evm-policy";

export interface EvmOwner { type: "evm"; address: string; chain_id: number; public_key: string }
export interface EvmConnection { address: string; chainId: number }
export interface EvmOwnerSigner {
  type: "evm";
  getIdentity(): Promise<EvmConnection | null>;
  signTypedData(payload: TypedDataDefinition): Promise<Hex>;
}

const DOMAIN = { name: "NEAR Wallet Contract", version: "1" } as const;
const TYPES = {
  EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }],
  Authorization: [{ name: "purpose", type: "string" }, { name: "recipient", type: "string" },
    { name: "payload", type: "string" }],
} as const;
export interface EvmConsent {
  domain: typeof DOMAIN;
  types: typeof TYPES;
  primaryType: "Authorization";
  message: { purpose: string; recipient: string; payload: string };
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const hex = (value: unknown, digits: number): value is Hex => typeof value === "string"
  && value.length === digits + 2 && /^0x[0-9a-f]+$/.test(value);
const chain = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (record(v)) return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function isEvmOwner(value: unknown): value is EvmOwner {
  if (!record(value) || value.type !== "evm" || !only(value, ["type", "address", "chain_id", "public_key"])) return false;
  if (!hex(value.address, 40) || !hex(value.public_key, 128) || !chain(value.chain_id)) return false;
  return publicKeyToAddress(`0x04${value.public_key.slice(2)}`).toLowerCase() === value.address;
}

function authorizationMessage(message: unknown, recipient: string) {
  if (!record(message) || message.purpose !== "PROVE_OWNERSHIP" || message.recipient !== recipient
    || !only(message, ["purpose", "recipient", "payload"])) return null;
  if (typeof message.payload !== "string" || message.payload.length > 16384) return null;
  return { purpose: "PROVE_OWNERSHIP", recipient, payload: message.payload };
}

export function evmConsent(payload: Record<string, unknown>, recipient: string): EvmConsent | null {
  if (!recipient || payload.primaryType !== "Authorization" || canonical(payload.types) !== canonical(TYPES)
    || canonical(payload.domain) !== canonical(DOMAIN)
    || !only(payload, ["domain", "types", "primaryType", "message"])) return null;
  const message = authorizationMessage(payload.message, recipient);
  return message ? { domain: DOMAIN, types: TYPES, primaryType: "Authorization", message } : null;
}

const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
export async function signEvmConsent(request: {
  owner: EvmOwner; payload: EvmConsent | EvmPolicyMessage; expiresAt: string;
}, signer: EvmOwnerSigner) {
  const { owner, payload, expiresAt } = structuredClone(request);
  const current = async () => {
    const identity = await signer.getIdentity();
    if (!identity || identity.address.toLowerCase() !== owner.address || identity.chainId !== owner.chain_id) {
      throw new Error("Your connected wallet or chain changed. Reconnect the agent's owner wallet.");
    }
    if (!(Date.parse(expiresAt) > Date.now())) throw new Error("That request expired while signing.");
  };
  await current();
  const signature = await signer.signTypedData(structuredClone(payload));
  await current();
  if (!/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature)
    || BigInt(`0x${signature.slice(66, 130)}`) > HALF_ORDER) throw new Error("Your wallet returned an invalid signature.");
  const key = await recoverPublicKey({ hash: hashTypedData<TypedData, string>(payload), signature });
  if (`0x${key.slice(4).toLowerCase()}` !== owner.public_key) {
    throw new Error("Your wallet signed with a different account or key. Sign in again with the agent's owner wallet.");
  }
  await current();
  return { standard: "eip712", payload, signature };
}
