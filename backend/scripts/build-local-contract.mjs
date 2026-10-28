import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(backend, '.local', 'wasm');
mkdirSync(out, { recursive: true });
const result = spawnSync('cargo', ['near', 'build', 'non-reproducible-wasm', '--locked', '--no-abi', '--manifest-path', resolve(backend, '../contracts/rounds/Cargo.toml'), '--out-dir', out], {
  cwd: resolve(backend, '../contracts'),
  stdio: 'inherit',
  env: { ...process.env, PATH: `${join(homedir(), '.cargo/bin')}:${process.env.PATH ?? ''}`, CARGO_TARGET_DIR: join(backend, '.local', 'cargo-target') },
});
if (result.error) console.error('Build failed: install the repository Rust toolchain and cargo-near.');
process.exitCode = result.status ?? 1;
