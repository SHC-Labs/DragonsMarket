export function run(
  opts: { rpc: string; rounds: string; account: string; publishers: string; 'dry-run'?: boolean; 'key-file'?: string },
  env: NodeJS.ProcessEnv,
): Promise<number>;
