export interface KeeperOptions {
  rpc: string;
  market: string;
  oracle: string;
  council: string;
  account?: string;
  'state-file': string;
  'events-file': string;
  'prepare-feed'?: boolean;
  'dry-run'?: boolean;
  'require-live-feed': true;
  'require-scoped-keys': true;
  workers: number;
  'job-batch': number;
}

export interface KeeperKeys {
  oracle?: string;
  market?: string;
  council?: string;
}

export interface KeeperAction {
  contract: string;
  method: string;
  args: Record<string, string>;
  gas: bigint;
}

export interface KeeperExecution {
  beforeBatch(actions: KeeperAction[]): Promise<void>;
  send(action: KeeperAction): Promise<string>;
}
export const KEEPER_METHODS: Readonly<Record<'market' | 'oracle' | 'council', readonly string[]>>;

export function setRpcPace(milliseconds: number): void;
export function setRpcCredentials(entries: [string, string][]): void;

export function keeperRpc(urls: string, method: string, params: unknown): Promise<unknown>;
export function keeperFeedCurrent(options: KeeperOptions, header: { height: string; hash: string; timestamp_nanosec: string }): boolean;
export function signedFunctionCall(input: {
  signer: string; seed: Buffer; publicKey: Buffer; nonce: bigint; receiver: string;
  blockHash: Buffer; method: string; args: Buffer; gas: bigint; deposit?: bigint;
}): string;
export function validateActionKeys(options: KeeperOptions, keys: KeeperKeys, actions: KeeperAction[]): Promise<void>;

export function queuedRun(options: KeeperOptions, keys: KeeperKeys, execution?: KeeperExecution): Promise<{
  actions: KeeperAction[];
  state: { cursor: { height: string; hash: string; timestampNs?: string } | null };
  current?: boolean;
}>;
