import { AgentApiUnavailable } from './agent-api.js';

// One in-flight provider probe per worker; retain successes and failures for at most 30 seconds.
// Database readiness remains uncached. This is not a dispatch or receipt-reconciliation gate.
export function agentReadiness(database: () => Promise<void>, provider: () => Promise<void>,
  now = () => performance.now()): () => Promise<void> {
  let checkedAt = -Infinity, healthy = false;
  let pending: Promise<void> | undefined;
  const unavailable = () => new AgentApiUnavailable('agent_provider_not_ready');
  const probe = () => {
    if (pending) return pending;
    if (now() - checkedAt < 30000) return healthy ? Promise.resolve() : Promise.reject(unavailable());
    pending = provider().then(() => { healthy = true; }, () => { healthy = false; throw unavailable(); })
      .finally(() => { checkedAt = now(); pending = undefined; });
    return pending;
  };
  return async () => { await Promise.all([database(), probe()]); };
}
