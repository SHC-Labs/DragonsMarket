// Everything the site needs to know about where the contracts live. Set at build time:
//   NEXT_PUBLIC_NETWORK  sandbox | testnet | mainnet   (default testnet)
//   NEXT_PUBLIC_RPC_URL  JSON-RPC endpoint            (default depends on the network)
//   NEXT_PUBLIC_MARKET_ID, NEXT_PUBLIC_ORACLE_ID, NEXT_PUBLIC_COUNCIL_ID   contract account ids
//   NEXT_PUBLIC_VERIFIER_ID          the NEAR Intents verifier that holds all collateral (intents.near on mainnet)
//   NEXT_PUBLIC_COLLATERAL_TOKEN_ID  the collateral's id in the verifier, "nep141:<token contract>"
//   NEXT_PUBLIC_NFT_ID               the Council seat NFT collection
//   NEXT_PUBLIC_TOKEN_ID             the NEP-141 contract itself; only the test faucet calls it
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
  councilId: process.env.NEXT_PUBLIC_COUNCIL_ID ?? "",
  verifierId: process.env.NEXT_PUBLIC_VERIFIER_ID ?? "",
  collateralTokenId: process.env.NEXT_PUBLIC_COLLATERAL_TOKEN_ID ?? "",
  nftId: process.env.NEXT_PUBLIC_NFT_ID ?? "",
  tokenId: process.env.NEXT_PUBLIC_TOKEN_ID ?? "",
  tokenSymbol: network === "mainnet" ? "USDC" : "mUSD",
  tokenDecimals: 6,
};

export const isConfigured = Boolean(config.marketId && config.oracleId && config.verifierId && config.collateralTokenId);
export const isTestMoney = network !== "mainnet";

// Shown before funding. Plain text for the interface to display.
export const WALLET_RULE_V1 = "This version connects NEAR wallets. Support for wallets on other chains is planned.";
