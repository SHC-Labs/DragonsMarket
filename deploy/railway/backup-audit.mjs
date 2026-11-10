import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectId, environmentId, railwayQuery, verifySource } from './release.mjs';
import { readBackups, verifyBackups } from './backups.mjs';

export async function auditBackups(query, now = Date.now()) {
  const { projectToken } = await query('query { projectToken { projectId environmentId } }');
  if (projectToken?.projectId !== projectId || projectToken?.environmentId !== environmentId) {
    throw new Error('Backup audit requires the Dragons Market production project token');
  }
  const { schedules, backups } = await readBackups(query, projectId, environmentId);
  verifyBackups(schedules, backups, now);
  const latest = Math.max(...backups.filter(backup => backup.expiresAt === null ||
    Date.parse(backup.expiresAt) > now).map(backup => Date.parse(backup.createdAt))
    .filter(created => Number.isFinite(created) && created <= now));
  return `Daily/weekly retention and a recent backup verified. Newest unexpired backup: ${
    new Date(latest).toISOString()}. This checks metadata, not restore integrity.`;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node deploy/railway/backup-audit.mjs');
  verifySource(process.env, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }));
  const message = await auditBackups(railwayQuery(process.env.RAILWAY_TOKEN));
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
