// Everything the site needs to know about where the contracts live. Set at build time:
//   NEXT_PUBLIC_NETWORK  sandbox | testnet | mainnet   (default testnet)
//   NEXT_PUBLIC_RPC_URL  JSON-RPC endpoint            (default depends on the network)
//   NEXT_PUBLIC_MARKET_ID, NEXT_PUBLIC_ORACLE_ID, NEXT_PUBLIC_TOKEN_ID   contract account ids
export type Network = "sandbox" | "testnet" | "mainnet";

const network = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as Network;

const DEFAULT_RPC: Record<Network, string> = {
  sandbox: "http://127.0.0.1:3030",
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

export const config = {
  network,
  rpcUrl: network === "sandbox" && process.env.NODE_ENV === "development"
    ? "/local-rpc"
    : process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC[network],
  marketId: process.env.NEXT_PUBLIC_MARKET_ID ?? "",
  oracleId: process.env.NEXT_PUBLIC_ORACLE_ID ?? "",
  tokenId: process.env.NEXT_PUBLIC_TOKEN_ID ?? "",
  tokenSymbol: network === "mainnet" ? "USDC" : "mUSD",
  tokenDecimals: 6,
};

export const isConfigured = Boolean(config.marketId && config.oracleId && config.tokenId);
export const isTestMoney = network !== "mainnet";
