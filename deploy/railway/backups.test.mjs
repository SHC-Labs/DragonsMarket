import test from 'node:test';
import assert from 'node:assert/strict';
import { readBackups, verifyBackups } from './backups.mjs';

const now = Date.parse('2026-11-07T12:00:00Z');
const schedules = [{ kind: 'DAILY', retentionSeconds: 518400 }, { kind: 'WEEKLY', retentionSeconds: 2332800 }];
const backup = { createdAt: '2026-11-07T02:00:00Z', expiresAt: '2026-11-13T02:00:00Z' };

test('release needs both retention schedules and a recent unexpired backup', () => {
  verifyBackups(schedules, [backup], now);
  verifyBackups(schedules, [{ ...backup, expiresAt: null }], now);
  for (const bad of [[], [{ ...backup, createdAt: '2026-11-01T00:00:00Z' }],
    [{ ...backup, expiresAt: '2026-11-06T00:00:00Z' }], [{ ...backup, createdAt: '2027-01-01T00:00:00Z' }],
    [{ ...backup, createdAt: 'invalid' }], [{ ...backup, expiresAt: 'invalid' }]]) {
    assert.throws(() => verifyBackups(schedules, bad, now), /backup/);
  }
  for (const bad of [[], [{ kind: 'MONTHLY' }], [{ kind: 'DAILY' }]]) {
    assert.throws(() => verifyBackups(bad, [backup], now), /daily and weekly/);
  }
  for (const seconds of [undefined, 0, 518399, '518400']) {
    assert.throws(() => verifyBackups([{ kind: 'DAILY', retentionSeconds: seconds }, schedules[1]],
      [backup], now), /retained/);
  }
  assert.throws(() => verifyBackups([schedules[0], { kind: 'WEEKLY', retentionSeconds: 2332799 }],
    [backup], now), /retained/);
});

test('backup reads target only the current Postgres mount in the approved environment', async () => {
  const volume = { id: 'current-volume-instance', serviceId: '130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0', mountPath: '/var/lib/postgresql/data' };
  const environment = { id: 'environment', projectId: 'project', volumeInstances: { edges: [{ node: volume }] } };
  let requests = 0;
  const query = async (query, variables) => {
    requests++;
    assert.ok(query.startsWith('query'), 'readiness cannot mutate or restore a database');
    if (requests === 1) return { environment };
    assert.equal(variables.id, volume.id);
    return { volumeInstanceBackupScheduleList: schedules, volumeInstanceBackupList: [backup] };
  };
  assert.equal((await readBackups(query, 'project', 'environment')).volumeInstanceId, volume.id);
  for (const bad of [{ ...environment, projectId: 'other' }, { ...environment, id: 'other' },
    { ...environment, volumeInstances: { edges: [] } },
    { ...environment, volumeInstances: { edges: [{ node: volume }, { node: volume }] } }]) {
    await assert.rejects(readBackups(async () => ({ environment: bad }), 'project', 'environment'));
  }
});
