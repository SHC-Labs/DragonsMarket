import { config } from "@/lib/config";

export const dynamic = "force-static";

export function GET() {
  return Response.json({
    version: 1,
    sourceCommit: process.env.NEXT_PUBLIC_RELEASE_COMMIT ?? "",
    network: config.network,
    marketId: config.marketId,
    oracleId: config.oracleId,
    councilId: config.councilId,
    verifierId: config.verifierId,
    nftId: config.nftId,
    collateralTokenId: config.collateralTokenId,
    tokenId: config.tokenId,
    tokenDecimals: config.tokenDecimals,
    rpcUrl: config.rpcUrl,
    backendUrl: config.backendUrl,
    mcpUrl: config.mcpUrl,
    agentWalletContract: config.agentWalletContract,
    agentApiHost: config.agentApiHost,
  });
}
