import { config } from "./config";
import { getMarketConfig, getOracleConfig } from "./market";
import { getCouncilConfig } from "./council";

// The site's verifier and collateral id must be the ones each contract was set up with, or every transfer is refused.
// Returns one line per disagreement; an empty list means the site and the contracts agree.
export async function configMismatches(): Promise<string[]> {
  const [market, oracle, council] = await Promise.all([getMarketConfig(), getOracleConfig(), getCouncilConfig()]);
  const found: string[] = [];
  for (const [name, c] of [["market", market], ["oracle", oracle], ["council", council]] as const) {
    if (c.verifier !== config.verifierId) found.push(`${name} uses verifier ${c.verifier}, the site expects ${config.verifierId}`);
    if (c.collateral_token_id !== config.collateralTokenId) {
      found.push(`${name} uses collateral ${c.collateral_token_id}, the site expects ${config.collateralTokenId}`);
    }
  }
  return found;
}
