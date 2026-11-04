import { followOperation } from './agents.js';
import { strandedOperations } from './operations.js';
import { followOwnerIntent, grantByCommitment, strandedIntents, type AgentAccounts } from './agent-accounts.js';

const TICK_MS = 15000;

const logged = (what: string) => (error: unknown) => {
  const reason = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
  console.error(`Agent sweep could not follow ${what}: ${reason}`);
};

export async function sweepAgents(s: AgentAccounts) {
  for (const intent of await strandedIntents(s)) await followOwnerIntent(s, intent).catch(logged('an owner intent'));
  const findGrant = (agentId: string, commitment: string) => grantByCommitment(s, agentId, commitment);
  for (const op of await strandedOperations(s.db, s.deployment.id)) {
    await followOperation(s.runner, op, findGrant).catch(logged('an operation'));
  }
}

export function startAgentSweep(s: AgentAccounts) {
  let running: Promise<void> | null = null;
  const tick = () => {
    running ??= sweepAgents(s).catch(logged('its work')).finally(() => { running = null; });
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return { stop: () => { clearInterval(timer); return running ?? Promise.resolve(); } };
}
