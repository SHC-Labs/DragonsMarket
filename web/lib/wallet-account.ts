// The one shape every connected wallet reduces to. `account` is the id the Intents verifier, the market and the oracle know
// the person by. `label` is the address as the person's own wallet shows it.
export type Chain = "near" | "evm" | "solana";

export interface WalletAccount {
  chain: Chain;
  account: string;
  label: string;
}

export const CHAIN_NAME: Record<Chain, string> = { near: "NEAR", evm: "Ethereum-compatible", solana: "Solana" };

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

export const nearAccount = (id: string): WalletAccount => ({ chain: "near", account: id, label: id });

// The verifier knows an EVM account by its lowercase 0x address.
export function evmAccount(address: string): WalletAccount {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("The wallet returned an address that is not an Ethereum address.");
  return { chain: "evm", account: address.toLowerCase(), label: address };
}

// The verifier knows a Solana account by the 64 hex characters of its 32-byte public key.
export function solanaAccount(publicKey: Uint8Array, address: string): WalletAccount {
  if (publicKey.length !== 32) throw new Error("The wallet returned a Solana key of the wrong size.");
  return { chain: "solana", account: hex(publicKey), label: address };
}

export const signsWithRelay = (identity: WalletAccount | null): identity is WalletAccount & { chain: "evm" | "solana" } =>
  identity !== null && identity.chain !== "near";

// 0x123…abcd, for a place with room for about twelve characters.
export const shortAddress = (address: string) => `${address.slice(0, 5)}…${address.slice(-4)}`;
