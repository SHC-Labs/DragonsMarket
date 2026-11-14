import { createHash } from 'node:crypto';
import { canonical, object } from './ingestion/block.js';
export { assertDaoPolicy } from '@dragons-market/keeper/dao-policy';

export function daoPolicyHash(policy: unknown): string {
  // Sputnik serializes these two fields from HashSets. Their JSON order does not
  // carry authority and can differ between calls without a governance change.
  const sorted = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...value].sort() : value;
  const normalized = object(policy) && Array.isArray(policy.roles) ? { ...policy,
    roles: policy.roles.map(role => object(role) ? { ...role, permissions: sorted(role.permissions),
      kind: object(role.kind) && Array.isArray(role.kind.Group)
        ? { ...role.kind, Group: sorted(role.kind.Group) } : role.kind } : role) } : policy;
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}
