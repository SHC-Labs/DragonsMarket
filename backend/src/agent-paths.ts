export type Body = () => Promise<Record<string, unknown>>;
export interface Owner { account: string; publicKey: string }
export interface AgentRoutes {
  owner(method: string, path: string, owner: Owner, body: Body): Promise<unknown>;
  access(method: string, path: string, authorization: string | undefined, body: Body): Promise<unknown>;
}

export const agentPath =
  /^\/v1\/agents\/([0-9a-f]{64})\/(grant|actions|operations|claimable|freeze|unfreeze|revoke|access)$/;
export const tokenPath = /^\/v1\/agents\/([0-9a-f]{64})\/access\/([0-9a-f-]{36})\/(revoke|sign)$/;
export const intentPath = /^\/v1\/agent-intents\/(intent_[A-Za-z0-9_-]{1,128})(\/status)?$/;
export const accessPath =
  /^\/v1\/agent-access\/(session|agent|policy|rounds|quote|markets|positions|quote-buy|quote-sell|actions|operations|claimable)$/;
export const isAgentRoute = (p: string) =>
  p === '/v1/agents' || agentPath.test(p) || tokenPath.test(p) || intentPath.test(p);
export const isAgentAccessRoute = (p: string) => accessPath.test(p);
