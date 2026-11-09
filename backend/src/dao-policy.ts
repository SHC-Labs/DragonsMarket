import { createHash } from 'node:crypto';
import { canonical, object } from './ingestion/block.js';
import { isAccount, isUnits } from './validate.js';

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

function votesRequired(policy: unknown, members: number): bigint {
  if (!object(policy) || policy.weight_kind !== 'RoleWeight' || !isUnits(policy.quorum))
    throw new Error('unsupported_dao_vote_policy');
  let threshold: bigint;
  if (isUnits(policy.threshold)) threshold = BigInt(policy.threshold);
  else {
    const ratio = policy.threshold;
    if (!Array.isArray(ratio) || ratio.length !== 2
      || !ratio.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4294967295)
      || ratio[1] === 0 || ratio[0] > ratio[1]) throw new Error('invalid_dao_vote_ratio');
    threshold = BigInt(ratio[0]) * BigInt(members) / BigInt(ratio[1]) + 1n;
  }
  threshold = threshold > BigInt(members) ? BigInt(members) : threshold;
  return threshold > BigInt(policy.quorum) ? threshold : BigInt(policy.quorum);
}

function checkedMembers(role: Record<string, unknown>, defaults: unknown, minimum: number): number {
  if (role.kind === 'Everyone') return 0; // Sputnik excludes this role from proposal_status.
  const members = object(role.kind) ? role.kind.Group : null;
  if (!Array.isArray(members) || !members.length || members.length > 100
    || !members.every(isAccount) || new Set(members).size !== members.length)
    throw new Error('unsupported_dao_approver_role');
  // Finalize evaluates every role, including roles without VoteApprove permission.
  // A zero-threshold requestor role must not approve a proposal through that path.
  for (const voting of [defaults, ...Object.values(role.vote_policy as Record<string, unknown>)]) {
    const votes = votesRequired(voting, members.length);
    if (votes < BigInt(minimum) || votes > BigInt(members.length))
      throw new Error('unsafe_dao_approval_threshold');
  }
  return members.length;
}

// Each role can independently authorize execution in Sputnik. A stronger default
// or another role does not override a permissive role-specific policy.
export function assertDaoPolicy(policy: unknown, minimum: number) {
  if (!Number.isSafeInteger(minimum) || minimum < 2 || minimum > 100
    || !object(policy) || !Array.isArray(policy.roles) || !policy.roles.length
    || policy.roles.length > 100) throw new Error('invalid_dao_policy');
  const names = new Set<string>();
  const executable = new Set<string>();
  for (const role of policy.roles) {
    if (!object(role) || typeof role.name !== 'string' || !role.name.trim() || names.has(role.name)
      || !Array.isArray(role.permissions) || !object(role.vote_policy))
      throw new Error('invalid_dao_role');
    names.add(role.name);
    const members = checkedMembers(role, policy.default_vote_policy, minimum);
    for (const permission of role.permissions) {
      if (typeof permission !== 'string' || !/^[a-z_*]+:[A-Za-z*]+$/.test(permission))
        throw new Error('invalid_dao_permission');
      const [kind, action] = permission.split(':');
      if (action !== 'VoteApprove' && action !== '*') continue;
      if (!members) throw new Error('unsupported_dao_approver_role');
      for (const label of kind === '*' ? ['call', 'transfer'] : [kind!]) executable.add(label);
    }
  }
  if (!executable.has('call') || !executable.has('transfer')) throw new Error('dao_execution_unavailable');
}
