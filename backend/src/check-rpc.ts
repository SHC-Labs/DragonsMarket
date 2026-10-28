import { readNetwork } from './config.js';
import { readRpcSettings, ReadRpcClient, checkProvider } from './providers.js';

try {
  const network = readNetwork(process.env);
  const settings = readRpcSettings(process.env, network);
  const checks = [await checkProvider(new ReadRpcClient(settings.primaryUrl, settings, settings.primaryBearerToken), network, 'primary')];
  if (settings.archivalUrl) checks.push(await checkProvider(new ReadRpcClient(settings.archivalUrl, settings), network, 'archive'));
  console.log(JSON.stringify({ network, checks, note: 'Read-only diagnostic. Archive retention, limits and full indexing coverage are not established by this check.' }, null, 2));
  if (checks.some(check => !check.networkVerified || !check.finalizedBlock || check.error)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid RPC configuration');
  process.exitCode = 1;
}
