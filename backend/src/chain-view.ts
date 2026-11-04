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

const callFunction = (contract: string, method: string, args: unknown) => ({
  request_type: 'call_function',
  account_id: contract,
  method_name: method,
  args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
});

const viewBytes = (result: unknown) =>
  (object(result) && Array.isArray(result.result) && result.result.length <= MAX_VIEW_RESULT_BYTES
    && !result.result.some(b => !Number.isInteger(b) || b < 0 || b > 255) ? result.result as number[] : null);

const decoded = (bytes: number[]) => parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));

/** Contract views pinned to one block hash, so every number in a report comes from the same state. */
export function viewAt(rpc: Rpc, blockHash: string): View {
  return async (contract, method, args) => {
    const result = await rpc.call('query', { ...callFunction(contract, method, args), block_id: blockHash });
    const bytes = viewBytes(result);
    if (!object(result) || result.block_hash !== blockHash || !bytes) throw new Error('invalid_finalized_view');
    return decoded(bytes);
  };
}

export function finalView(rpc: Rpc): View {
  return (contract, method, args) => rpc.call('query', { ...callFunction(contract, method, args), finality: 'final' })
    .then(result => {
      const bytes = viewBytes(result);
      if (!bytes) throw new Error('invalid_view');
      return decoded(bytes);
    });
}
