// A market id the backend would accept: the market contract keeps ids as decimal numbers.
export const isWatchableId = (id: string) => /^\d{1,20}$/.test(id);
export const MAX_WATCHED = 200;

export interface Merge { ids: string[]; push: string[]; remove: string[] }

/**
 * Brings this browser's list and the account's server list together. A market the person removed here stays removed (it is in
 * `removed` until the server confirms), so a device that still holds an old copy cannot bring it back. Ids that the server
 * cannot hold are kept out of both.
 */
export function mergeWatchlists({ local, remote, removed }: { local: string[]; remote: string[]; removed: string[] }): Merge {
  const gone = new Set(removed);
  const ids = [...new Set([...local, ...remote])].filter(id => isWatchableId(id) && !gone.has(id)).slice(0, MAX_WATCHED);
  const onServer = new Set(remote);
  return { ids, push: ids.filter(id => !onServer.has(id)), remove: removed.filter(id => onServer.has(id)) };
}
