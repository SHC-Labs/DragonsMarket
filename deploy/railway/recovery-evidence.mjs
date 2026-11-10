import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { projectId, environmentId } from './release.mjs';

const postgresId = '130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0';
const requiredCatalogs = ['columns', 'indexes', 'constraints', 'functions', 'triggers',
  'relations', 'sequence_definitions', 'schema', 'roles', 'memberships', 'defaults', 'policies',
  'role_settings', 'database'];

function inventory(records, kind, count) {
  const selected = records.filter(record => record.kind === kind);
  if (selected.length !== count || selected.some(record => typeof record.name !== 'string' || !record.name) ||
      new Set(selected.map(record => record.name)).size !== count) {
    throw new Error('Recovery inventory is incomplete');
  }
  return selected;
}

function validateDigests(records) {
  for (const record of records) {
    if (!/^[0-9a-f]{64}$/.test(record.sha256 ?? '')) throw new Error('Invalid recovery digest');
  }
}

export function parseEvidence(output) {
  const records = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const identity = records[0];
  if (identity?.kind !== 'identity' || identity.format !== 3 || identity.readOnly !== 'on' ||
      typeof identity.database !== 'string' || !/^18\d{4}$/.test(identity.version ?? '') ||
      !Number.isSafeInteger(identity.tables) || identity.tables < 1 ||
      !Number.isSafeInteger(identity.sequences) || identity.sequences < 0 ||
      records.at(-1)?.kind !== 'complete' || records.at(-1)?.format !== 3) {
    throw new Error('Incomplete recovery evidence');
  }
  const tables = inventory(records, 'table', identity.tables);
  const sequences = inventory(records, 'sequence', identity.sequences);
  const catalogs = inventory(records, 'catalog', requiredCatalogs.length);
  if (records.length !== 2 + tables.length + sequences.length + catalogs.length ||
      !requiredCatalogs.every(name => catalogs.some(catalog => catalog.name === name)) ||
      catalogs.find(catalog => catalog.name === 'sequence_definitions').entries !== identity.sequences) {
    throw new Error('Recovery inventory is incomplete');
  }
  validateDigests([...tables, ...catalogs]);
  if (sequences.some(record => !/^-?\d+$/.test(record.lastValue ?? '') ||
      typeof record.isCalled !== 'boolean') ||
      catalogs.some(record => !Number.isSafeInteger(record.entries) || record.entries < 0)) {
    throw new Error('Invalid recovery metadata');
  }
  if (tables.some(table => table.complete !== true || !Number.isSafeInteger(table.rows) ||
      table.rows < 0 || table.rows > 100000)) {
    throw new Error('Recovery evidence exceeds the foundation drill limit of 100000 rows per table');
  }
  return records;
}

export function captureEvidence(run = execFileSync) {
  const sql = readFileSync(new URL('../../backend/ops/recovery-evidence.sql', import.meta.url));
  // The payload contains reviewed SQL, never credentials. Railway joins command
  // arguments for a remote shell, so pass one command with a base64-only payload.
  const command = `printf '%s' '${sql.toString('base64')}' | base64 -d | ` +
    'psql -XqAt --pset=pager=off --no-password --set=ON_ERROR_STOP=1 --file=-';
  const output = run('railway', ['ssh', '--project', projectId, '--environment', environmentId,
    '--service', postgresId, '--', command],
  { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return parseEvidence(output);
}

export function compareEvidence(before, after) {
  if (!isDeepStrictEqual(before, after)) {
    throw new Error('Recovery evidence differs; keep writers stopped and investigate or roll back');
  }
}

function main() {
  const [action, file] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['capture', 'compare'].includes(action) || !file) {
    throw new Error('Usage: node deploy/railway/recovery-evidence.mjs <capture|compare> <private-file>');
  }
  const before = action === 'compare' ? parseEvidence(readFileSync(file, 'utf8')) : undefined;
  const records = captureEvidence();
  if (before) {
    compareEvidence(before, records);
    console.log('Database identity, data digests, schema and permission evidence match');
  } else {
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n',
      { flag: 'wx', mode: 0o600 });
    console.log('Read-only recovery evidence saved; this is not proof of a restore or a writer freeze');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch {
    console.error('Recovery check failed; keep writers stopped if a drill is in progress. No restore was requested.');
    process.exitCode = 1;
  }
}
