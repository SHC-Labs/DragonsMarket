import { recoverMessageAddress } from "viem";
import { base58Decode } from "./base58";
import { config } from "./config";
import { cashOutError, type CrossChainQuote } from "./cross-chain-quote";
import { record } from "./receipt-proof";
import { toHex, type MultiPayload } from "./signed-intents";

function parsePayload(value: unknown, standard: string) {
  if (!record(value) || value.standard !== standard || typeof value.payload !== "string"
    || value.payload.length > 2048) throw cashOutError();
  const payload: unknown = JSON.parse(value.payload);
  if (!record(payload) || Object.keys(payload).length !== 5
    || JSON.stringify(payload) !== value.payload) throw cashOutError();
  return { payload, text: value.payload };
}

function checkNonce(nonce: unknown) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(nonce)
    || btoa(atob(nonce)) !== nonce) throw cashOutError();
}

function checkTransfer(transfer: unknown, quote: CrossChainQuote) {
  if (!record(transfer) || Object.keys(transfer).length !== 3 || transfer.intent !== "transfer"
    || transfer.receiver_id !== quote.depositAddress || !record(transfer.tokens)
    || Object.keys(transfer.tokens).length !== 1 || transfer.tokens[config.collateralTokenId] !== quote.amount) {
    throw cashOutError();
  }
}

export function cashOutPayload(value: unknown, quote: CrossChainQuote): string {
  const standard = quote.identity.chain === "evm" ? "erc191" : "raw_ed25519";
  const { payload, text } = parsePayload(value, standard);
  if (payload.signer_id !== quote.identity.account || payload.verifying_contract !== config.verifierId
    || payload.deadline !== quote.authorizationDeadline) throw cashOutError();
  checkNonce(payload.nonce);
  if (!Array.isArray(payload.intents) || payload.intents.length !== 1) throw cashOutError();
  checkTransfer(payload.intents[0], quote);
  return text;
}

async function verifyErc191(signature: string, payload: string, account: string) {
  if (!signature.startsWith("secp256k1:")) throw cashOutError();
  const bytes = base58Decode(signature.slice(10));
  if (bytes.length !== 65 || bytes[64] > 1) throw cashOutError();
  const address = await recoverMessageAddress({ message: payload, signature: toHex(bytes) as `0x${string}` });
  if (address.toLowerCase() !== account) throw cashOutError();
}

async function verifyEd25519(signed: Extract<MultiPayload, { standard: "raw_ed25519" }>, label: string) {
  if (signed.public_key !== `ed25519:${label}` || !signed.signature.startsWith("ed25519:")) {
    throw cashOutError();
  }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(base58Decode(label)),
    { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", key,
    new Uint8Array(base58Decode(signed.signature.slice(8))), new TextEncoder().encode(signed.payload));
  if (!valid) throw cashOutError();
}

export async function verifyCashOutSignature(signed: MultiPayload, payload: string, quote: CrossChainQuote) {
  if (cashOutPayload(signed, quote) !== payload || typeof signed.signature !== "string") throw cashOutError();
  if (signed.signature.length > 100) throw cashOutError();
  if (Object.keys(signed).length !== (signed.standard === "erc191" ? 3 : 4)) throw cashOutError();
  return signed.standard === "erc191" ? verifyErc191(signed.signature, payload, quote.identity.account)
    : verifyEd25519(signed, quote.identity.label);
}
