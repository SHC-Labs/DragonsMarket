import { base58Encode } from "./base58";
import { UserFacingError } from "./errors";

// Payloads an EVM or Solana wallet signs and the Intents verifier executes (execute_intents). The signed string and the
// submitted string must be byte-identical, so a payload is built once as a string and never re-serialised.

export interface IntentsContext {
  verifier: string;
  collateral: string;
  relayer: string;
  relayFee: bigint;
}

export interface TransferIntent {
  intent: "transfer";
  receiver_id: string;
  tokens: Record<string, string>;
  msg?: string;
}

export type MultiPayload =
  | { standard: "erc191"; payload: string; signature: string }
  | { standard: "raw_ed25519"; payload: string; public_key: string; signature: string };

// Valid for five minutes. The relay refuses anything further out than ten.
export const PAYLOAD_LIFETIME_MS = 5 * 60_000;

// What the person agrees to: send `amount` to `to` with `msg`. The fee to the relayer is added by actionPayload.
export type Action = {
  kind?: "transfer";
  to: string;
  amount: bigint;
  msg: string;
} | { kind: "auth"; to: string; msg: string };

export const RELAY_AUTH_GAS = "100000000000000";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
// The verifier reads a nonce that starts with these four bytes as a versioned one, and the relay refuses it.
const VERSIONED_NONCE = [0x56, 0x28, 0xf6, 0xc6];
export function randomNonce() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    if (!VERSIONED_NONCE.every((byte, i) => bytes[i] === byte)) return base64(bytes);
  }
}

export function transferIntent(to: string, token: string, amount: bigint, msg?: string): TransferIntent {
  return msg === undefined
    ? { intent: "transfer", receiver_id: to, tokens: { [token]: amount.toString() } }
    : { intent: "transfer", receiver_id: to, tokens: { [token]: amount.toString() }, msg };
}

// The relay refuses a longer payload.
export const MAX_PAYLOAD_CHARS = 2048;

export function actionPayload(ctx: IntentsContext, signerId: string, action: Action, now = Date.now(), nonce = randomNonce()): string {
  if ((action.kind !== "auth" && action.amount <= 0n) || ctx.relayFee <= 0n) throw new Error("A signed transfer needs a positive amount.");
  const payload = JSON.stringify({
    signer_id: signerId,
    verifying_contract: ctx.verifier,
    deadline: new Date(now + PAYLOAD_LIFETIME_MS).toISOString(),
    nonce,
    intents: [
      action.kind === "auth"
        ? { intent: "auth_call", contract_id: action.to, msg: action.msg, min_gas: RELAY_AUTH_GAS }
        : transferIntent(action.to, ctx.collateral, action.amount, action.msg),
      transferIntent(ctx.relayer, ctx.collateral, ctx.relayFee),
    ],
  });
  if (JSON.stringify(JSON.parse(payload)) !== payload) throw new Error("The signed message is not in its canonical form.");
  if (payload.length > MAX_PAYLOAD_CHARS) throw new UserFacingError("That request is too long to sign. Shorten the evidence and try again.");
  return payload;
}

// secp256k1 signature of an EIP-191 personal message: r || s || v as a wallet returns it. The verifier wants v as 0 or 1.
export function encodeErc191(payload: string, signatureHex: string): MultiPayload {
  if (/^0x(?:[0-9a-fA-F]{2})+$/.test(signatureHex) && signatureHex.length !== 132) {
    // Safe, Coinbase Smart Wallet and other contract accounts sign with ERC-1271 or ERC-6492, which the Intents verifier cannot check.
    throw new UserFacingError("Smart-contract wallets (such as Safe or Coinbase Smart Wallet) are not supported yet. Use a wallet with its own key, such as MetaMask or Rabby.");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) throw new Error("The wallet returned a signature of the wrong size.");
  const bytes = Uint8Array.from(signatureHex.slice(2).match(/../g)!, byte => parseInt(byte, 16));
  const v = bytes[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error("The wallet returned a signature this site cannot use.");
  bytes[64] = recovery;
  return { standard: "erc191", payload, signature: `secp256k1:${base58Encode(bytes)}` };
}

export function encodeEd25519(payload: string, publicKey: Uint8Array, signature: Uint8Array): MultiPayload {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error("The wallet returned a key or signature of the wrong size.");
  return { standard: "raw_ed25519", payload, public_key: `ed25519:${base58Encode(publicKey)}`, signature: `ed25519:${base58Encode(signature)}` };
}

export const utf8 = (text: string) => new TextEncoder().encode(text);
export const toHex = (bytes: Uint8Array) => `0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`;

// Evidence rides inside the signed proposal message. The relay refuses control characters and more than 512 UTF-8 bytes, so
// both are handled here where the person can still fix the text. Direction overrides are dropped so the text reads as stored.
export const MAX_EVIDENCE_BYTES = 512;
export function cleanEvidence(input: string): { text: string; fits: boolean } {
  const text = input.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return { text, fits: utf8(text).length <= MAX_EVIDENCE_BYTES };
}
