import type { Network } from "./config";

// Bump the relevant version whenever the published document changes materially.
export const LEGAL_DOCUMENTS = {
  terms: { version: "2026-10-19.3", href: "/terms", label: "Terms of Use" },
  privacy: { version: "2026-10-19.3", href: "/privacy", label: "Privacy Policy" },
} as const;

export interface LegalAcceptance {
  schema: 1;
  method: "clickwrap";
  accountId: string;
  network: Network;
  termsVersion: string;
  privacyVersion: string;
  termsAgreed: true;
  privacyAcknowledged: true;
  acceptedAt: string;
}

export function legalAcceptanceKey(accountId: string, network: Network): string {
  return `dragons-market:legal:${network}:${encodeURIComponent(accountId)}`;
}

export function createLegalAcceptance(accountId: string, network: Network, now = new Date()): LegalAcceptance {
  if (!accountId) throw new Error("A connected wallet is required.");
  return {
    schema: 1, method: "clickwrap", accountId, network,
    termsVersion: LEGAL_DOCUMENTS.terms.version,
    privacyVersion: LEGAL_DOCUMENTS.privacy.version,
    termsAgreed: true, privacyAcknowledged: true, acceptedAt: now.toISOString(),
  };
}

// Browser preference validation, not proof of identity, a signature or a server audit trail.
export function parseLegalAcceptance(raw: string | null, accountId: string, network: Network): LegalAcceptance | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const receipt = value as Partial<LegalAcceptance>;
    if (receipt.schema !== 1 || receipt.method !== "clickwrap" || receipt.accountId !== accountId || receipt.network !== network
      || receipt.termsVersion !== LEGAL_DOCUMENTS.terms.version || receipt.privacyVersion !== LEGAL_DOCUMENTS.privacy.version
      || receipt.termsAgreed !== true || receipt.privacyAcknowledged !== true
      || typeof receipt.acceptedAt !== "string" || !Number.isFinite(Date.parse(receipt.acceptedAt))) return null;
    return receipt as LegalAcceptance;
  } catch { return null; }
}

export function readLegalAcceptance(storage: Pick<Storage, "getItem">, accountId: string, network: Network): LegalAcceptance | null {
  try { return parseLegalAcceptance(storage.getItem(legalAcceptanceKey(accountId, network)), accountId, network); }
  catch { return null; }
}

export function saveLegalAcceptance(storage: Pick<Storage, "getItem" | "setItem">, receipt: LegalAcceptance): void {
  const key = legalAcceptanceKey(receipt.accountId, receipt.network);
  const raw = JSON.stringify(receipt);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Acceptance could not be saved.");
}
