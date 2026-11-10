export type TreasuryTarget = 'market' | 'oracle' | 'council' | 'rounds';
export interface TreasuryContext {
  treasuryId: string;
  contracts: { market: string; oracle: string; council: string; rounds?: string };
  view: (account: string, method: string, args: Record<string, unknown>) => Promise<unknown>;
}
export interface TreasuryWalletRequest {
  receiverId: string;
  actions: { type: 'FunctionCall'; params: {
    methodName: string; args: Record<string, unknown>; gas: string; deposit: string;
  } }[];
}
export function prepareAdministrationProposal(input: TreasuryContext & {
  target: TreasuryTarget; methodName: string; args: Record<string, unknown>; description: string; gasTgas?: number;
}): Promise<TreasuryWalletRequest>;
export function prepareTreasuryVote(input: TreasuryContext & {
  proposalId: number; approve: boolean; acknowledge?: string[];
}): Promise<TreasuryWalletRequest>;
