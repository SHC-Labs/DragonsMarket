import { b58decode } from "./chain.mjs";

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const FIELDS = ["mode", "accountId", "ownerId", "codeHash", "publicKeys", "custodian", "reviewEvidence"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const account = (value) => typeof value === "string" && ACCOUNT.test(value);

function hash(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
    && b58decode(value).length === 32 && !/^1+$/.test(value);
}

function publicKey(value) {
  return typeof value === "string" && value.startsWith("ed25519:") && hash(value.slice(8));
}

function evidence(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export function parseNftCustody(value, accountId) {
  if (value === undefined) return { mode: "keyless" };
  if (!object(value)) throw new Error("invalid_nft_custody_policy");
  if (value.mode === "keyless" && Object.keys(value).length === 1) return value;
  if (value.mode !== "platform-managed" || Object.keys(value).length !== FIELDS.length
    || !FIELDS.every((field) => Object.hasOwn(value, field))) throw new Error("invalid_nft_custody_policy");
  validatePlatformPolicy(value, accountId);
  validateApprovedKeys(value.publicKeys);
  return value;
}

function validatePlatformPolicy(value, accountId) {
  if (!account(value.accountId) || value.accountId !== accountId || !account(value.ownerId)
    || !hash(value.codeHash)) throw new Error("invalid_nft_custody_identity");
  validateReview(value);
}

function validateReview(value) {
  if (typeof value.custodian !== "string" || !value.custodian.trim() || value.custodian.length > 200
    || !evidence(value.reviewEvidence)) throw new Error("invalid_nft_custody_review");
}

function validateApprovedKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8
    || !keys.every(publicKey) || new Set(keys).size !== keys.length) throw new Error("invalid_nft_custody_keys");
}

export function assertNftCustody(policy, snapshot) {
  const approved = parseNftCustody(policy, snapshot.accountId);
  if (!Array.isArray(snapshot.keys)) throw new Error("invalid_nft_access_keys");
  if (approved.mode === "keyless") {
    if (snapshot.keys.length) throw new Error("approved_nft_not_keyless");
    return;
  }
  assertPlatformIdentity(approved, snapshot);
  assertPlatformKeys(approved.publicKeys, snapshot.keys);
}

function assertPlatformIdentity(approved, snapshot) {
  if (!object(snapshot.account) || snapshot.account.global_contract_account_id
    || (snapshot.account.global_contract_hash ?? snapshot.account.code_hash) !== approved.codeHash)
    throw new Error("approved_nft_code_changed");
  if (snapshot.ownerId !== approved.ownerId) throw new Error("approved_nft_owner_changed");
}

function assertPlatformKeys(approved, keys) {
  if (keys.length !== approved.length || !keys.every((key) => object(key)
    && approved.includes(key.public_key) && key.access_key?.permission === "FullAccess")
    || new Set(keys.map((key) => key.public_key)).size !== keys.length)
    throw new Error("approved_nft_keys_changed");
}

export async function verifyNftCustody(policy, accountId, chain) {
  const approved = parseNftCustody(policy, accountId);
  const keys = await chain.keys(accountId);
  const snapshot = { accountId, keys };
  if (approved.mode === "platform-managed") {
    [snapshot.account, snapshot.ownerId] = await Promise.all([
      chain.account(accountId), chain.view(accountId, "get_owner", {}),
    ]);
  }
  assertNftCustody(approved, snapshot);
  return approved.mode === "keyless" ? `${accountId} has 0 access keys`
    : `${accountId} matches approved platform custody (${keys.length} full-access keys)`;
}
