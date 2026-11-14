import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentAccounts } from '../src/agent-accounts.js';
import { AgentApiError } from '../src/agent-api.js';
import { sweepAgents } from '../src/agent-sweep.js';

test('sweep failures expose no upstream details and do not prevent following independent work', async () => {
  const queries: string[] = [], followed: string[] = [], logs: unknown[][] = [];
  const s = {
    deployment: { id: 'fixture' },
    db: { query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('UPDATE agent_intents')) return { rows: [{ correlation_id: 'intent_one' },
        { correlation_id: 'intent_two' }] };
      if (sql.startsWith('SELECT i.correlation_id')) return { rows: [
        { correlation_id: 'intent_one', agent_id: 'a'.repeat(64), type: 'grant_issue' },
        { correlation_id: 'intent_two', agent_id: 'b'.repeat(64), type: 'agent_freeze' },
      ] };
      assert.ok(sql.startsWith('UPDATE user_operations'), 'the sweep continues to financial operations');
      return { rows: [] };
    } },
    api: { status: async (id: string) => {
      followed.push(id);
      if (id === 'intent_one') throw new AgentApiError(503, { errors: [{ status: '503', code: 'unavailable',
        title: 'private consent', detail: 'ngt_private_grant naa_private_key', layer: 'provider' }], meta: {} });
      throw new Error('postgresql://private:password@host/database');
    } },
  } as unknown as AgentAccounts;
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try { await sweepAgents(s); } finally { console.error = original; }
  assert.deepEqual(followed, ['intent_one', 'intent_two']);
  assert.equal(queries.length, 3);
  assert.deepEqual(logs, [['Agent sweep could not follow an owner intent'],
    ['Agent sweep could not follow an owner intent']]);
});
