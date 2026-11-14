export type NftCustody = { mode: 'keyless' } | {
  mode: 'platform-managed';
  accountId: string;
  ownerId: string;
  codeHash: string;
  publicKeys: string[];
  custodian: string;
  reviewEvidence: string;
};

export function parseNftCustody(value: unknown, accountId: string): NftCustody;
export function assertNftCustody(policy: NftCustody | undefined, snapshot: {
  accountId: string; keys: unknown; account?: unknown; ownerId?: unknown;
}): void;
export function verifyNftCustody(policy: NftCustody | undefined, accountId: string, chain: {
  keys(accountId: string): Promise<unknown>;
  account(accountId: string): Promise<unknown>;
  view(accountId: string, method: string, args: Record<string, never>): Promise<unknown>;
}): Promise<string>;
