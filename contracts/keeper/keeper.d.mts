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

export function setRpcPace(milliseconds: number): void;
export function setRpcCredentials(entries: [string, string][]): void;

export function queuedRun(options: KeeperOptions, keys: KeeperKeys): Promise<{
  actions: { contract: string; method: string; args: Record<string, string>; gas: bigint }[];
  state: { cursor: { height: string; hash: string; timestampNs?: string } | null };
  current?: boolean;
}>;
