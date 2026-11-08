export const postgresId = '130e30b5-c8b3-4a63-ae2f-2cc1e0901fc0';
const maxAge = 36 * 60 * 60 * 1000;
const retention = { DAILY: 6 * 86400, WEEKLY: 27 * 86400 };

export function verifyBackups(schedules, backups, now = Date.now()) {
  if (!Object.entries(retention).every(([kind, seconds]) => schedules.some(schedule =>
    schedule.kind === kind && Number.isSafeInteger(schedule.retentionSeconds) &&
    schedule.retentionSeconds >= seconds))) {
    throw new Error('Postgres requires daily and weekly backups retained for at least 6 and 27 days');
  }
  if (!backups.some(backup => {
    const created = Date.parse(backup.createdAt), expires = Date.parse(backup.expiresAt);
    return Number.isFinite(created) && created <= now && now - created <= maxAge &&
      (backup.expiresAt === null || (Number.isFinite(expires) && expires > now));
  })) throw new Error('Postgres has no unexpired backup from the past 36 hours');
}

export async function readBackups(query, projectId, environmentId) {
  const { environment } = await query(`query($id: String!) {
    environment(id: $id) { id projectId volumeInstances { edges { node { id serviceId mountPath } } } }
  }`, { id: environmentId });
  if (environment?.id !== environmentId || environment.projectId !== projectId) throw new Error('Backup environment identity mismatch');
  const volumes = environment.volumeInstances.edges.map(edge => edge.node)
    .filter(volume => volume.serviceId === postgresId && volume.mountPath === '/var/lib/postgresql/data');
  if (volumes.length !== 1) throw new Error('Expected exactly one mounted Postgres data volume');
  const volumeInstanceId = volumes[0].id;
  const data = await query(`query($id: String!) {
    volumeInstanceBackupScheduleList(volumeInstanceId: $id) { kind retentionSeconds }
    volumeInstanceBackupList(volumeInstanceId: $id) { id createdAt expiresAt }
  }`, { id: volumeInstanceId });
  return { volumeInstanceId, schedules: data.volumeInstanceBackupScheduleList, backups: data.volumeInstanceBackupList };
}

export async function checkBackups(query, projectId, environmentId) {
  const { schedules, backups } = await readBackups(query, projectId, environmentId);
  verifyBackups(schedules, backups);
}
