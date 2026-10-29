import type { Config } from './config.js';
import type { ReadRpcClient } from './providers.js';
import { object, parseJson } from './ingestion/block.js';

type Rpc = Pick<ReadRpcClient, 'call'>;
export type View = (contract: string, method: string, args: unknown) => Promise<unknown>;

const MAX_VIEW_RESULT_BYTES = 1024 * 1024;

/** The finalized head, after checking the node is on the configured network. */
export async function finalizedHead(config: Config, rpc: Rpc) {
  const status = await rpc.call('status', {});
  if (
    !object(status) ||
    typeof status.chain_id !== 'string' ||
    (config.network === 'sandbox' ? ['testnet', 'mainnet'].includes(status.chain_id) : status.chain_id !== config.network)
  )
    throw new Error('network_mismatch');
  const block = await rpc.call('block', { finality: 'final' });
  if (!object(block) || !object(block.header) || typeof block.header.hash !== 'string') throw new Error('invalid_finalized_head');
  return { hash: block.header.hash, height: String(block.header.height), timestampNs: String(block.header.timestamp_nanosec ?? '') };
}

/** Contract views pinned to one block hash, so every number in a report comes from the same state. */
export function viewAt(rpc: Rpc, blockHash: string): View {
  return async (contract, method, args) => {
    const result = await rpc.call('query', {
      request_type: 'call_function',
      block_id: blockHash,
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    if (
      !object(result) ||
      result.block_hash !== blockHash ||
      !Array.isArray(result.result) ||
      result.result.length > MAX_VIEW_RESULT_BYTES ||
      result.result.some(b => !Number.isInteger(b) || b < 0 || b > 255)
    )
      throw new Error('invalid_finalized_view');
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result)));
  };
}
