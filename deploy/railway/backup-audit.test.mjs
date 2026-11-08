import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBackups } from './backup-audit.mjs';
import { projectId, environmentId } from './release.mjs';

const now = Date.parse('2026-11-07T20:00:00Z');
const backup = { createdAt: '2026-11-07T17:45:41.680Z', expiresAt: null };
const schedules = [{ kind: 'DAILY', retentionSeconds: 518400 },
  { kind: 'WEEKLY', retentionSeconds: 2332800 }];

function reader(backups = [backup]) {
  return async (query, variables) => {
    assert.ok(query.startsWith('query'), 'Audit may not mutate Railway');
    assert.doesNotMatch(query, /variables\(|config\(|deploymentLogs/);
    if (query.includes('projectToken')) return { projectToken: { projectId, environmentId } };
    if (query.includes('environment(')) {
      assert.equal(variables.id, environmentId);
      return { environment: { id: environmentId, projectId, volumeInstances: { edges: [{ node: {
        id: 'volume', serviceId: '130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0',
        mountPath: '/var/lib/postgresql/data',
      } }] } } };
    }
    assert.equal(variables.id, 'volume');
    return { volumeInstanceBackupScheduleList: schedules, volumeInstanceBackupList: backups };
  };
}

test('audit reads only production backup metadata and distinguishes it from restore evidence', async () => {
  const message = await auditBackups(reader([backup,
    { createdAt: 'bad', expiresAt: null },
    { createdAt: '2027-01-01T00:00:00Z', expiresAt: null },
    { createdAt: '2026-11-07T19:00:00Z', expiresAt: '2026-11-07T19:30:00Z' },
  ]), now);
  assert.match(message, /2026-11-07T17:45:41.680Z/);
  assert.match(message, /metadata, not restore integrity/);
  await assert.rejects(auditBackups(reader([]), now), /past 36 hours/);
  await assert.rejects(auditBackups(reader([{ ...backup, createdAt: '2026-11-01T00:00:00Z' }]),
    now), /past 36 hours/);
});

test('wrong credential scope stops the audit before any volume query', async () => {
  for (const projectToken of [null, { projectId, environmentId: 'other' },
    { projectId: 'other', environmentId }]) {
    let calls = 0;
    await assert.rejects(auditBackups(async () => { calls++; return { projectToken }; }), /project token/);
    assert.equal(calls, 1);
  }
});
