import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function partition(metadata, index, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error('Usage: node run-sandbox-shard.mjs <zero-based-index> <shard-count>');
  }
  const targets = metadata.packages.find(pkg => pkg.name === 'tests')?.targets
    .filter(target => target.kind.includes('test')).map(target => target.name).sort();
  if (!targets?.length || targets.length < count) throw new Error('Sandbox targets missing or fewer than the configured shards');
  return targets.filter((_, position) => position % count === index);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
if (process.argv.length !== 4) throw new Error('Pass a shard index and count');
const [index, count] = process.argv.slice(2).map(Number);
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' }));
const selected = partition(metadata, index, count);
console.log(`Sandbox shard ${index + 1}/${count}: ${selected.join(', ')}`);
function run(args) {
  const result = spawnSync('cargo', ['test', '--locked', '-p', 'tests', ...args, '--', '--test-threads=2'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
run([...selected.flatMap(name => ['--test', name]), ...(index === 0 ? ['--lib'] : [])]);
if (index === 0) run(['--doc']);
}
