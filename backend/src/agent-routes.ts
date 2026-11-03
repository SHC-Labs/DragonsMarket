import { ReadError } from './read-api.js';
import { AgentApiError, AgentApiUnavailable, refusalCode } from './agent-api.js';
import { InvalidAction } from './agents.js';
import {
  agentOperations, createAgent, freezeAgent, issueGrant, listAgents, ownerIntentStatus, revokeGrants, runOwnedAction,
  submitOwnerIntent, type AgentAccounts, type Owner,
} from './agent-accounts.js';
import {
  accessFor, accessOperations, accessQuote, accessRounds, accessSession, accessSummary, createAccessToken,
  listAccessTokens, revokeAccessToken, runAccessAction, type Access,
} from './agent-access.js';

type Body = () => Promise<Record<string, unknown>>;
export interface AgentRoutes {
  owner(method: string, path: string, owner: Owner, body: Body): Promise<unknown>;
  access(method: string, path: string, authorization: string | undefined, body: Body): Promise<unknown>;
}
type OwnerHandler = (s: AgentAccounts, owner: Owner, ids: string[], body: Body) => Promise<unknown>;
type AccessHandler = (s: AgentAccounts, access: Access, body: Body) => Promise<unknown>;

const agentPath = /^\/v1\/agents\/([0-9a-f]{64})\/(grant|actions|operations|freeze|unfreeze|revoke|access)$/;
const tokenPath = /^\/v1\/agents\/([0-9a-f]{64})\/access\/([0-9a-f-]{36})\/revoke$/;
const intentPath = /^\/v1\/agent-intents\/(intent_[A-Za-z0-9_-]{1,128})(\/status)?$/;
const accessPath = /^\/v1\/agent-access\/(session|agent|rounds|quote|actions|operations)$/;
export const isAgentRoute = (p: string) =>
  p === '/v1/agents' || agentPath.test(p) || tokenPath.test(p) || intentPath.test(p);
export const isAgentAccessRoute = (p: string) => accessPath.test(p);

function unsettled(error: unknown): never {
  if (error instanceof AgentApiError) {
    throw error.status === 429 ? new ReadError(429, 'agent_api_rate_limited')
      : new ReadError(502, 'agent_api_unavailable');
  }
  throw error;
}

const ownerHandlers: Record<string, OwnerHandler> = {
  'GET agents': (s, owner) => listAgents(s, owner),
  'POST agents': (s, owner, _ids, body) => body().then(b => createAgent(s, owner, b.name)),
  'POST grant': (s, owner, [id = '']) => issueGrant(s, owner, id),
  'POST revoke': (s, owner, [id = '']) => revokeGrants(s, owner, id),
  'POST freeze': (s, owner, [id = '']) => freezeAgent(s, owner, id, true),
  'POST unfreeze': (s, owner, [id = '']) => freezeAgent(s, owner, id, false),
  'POST actions': (s, owner, [id = ''], body) =>
    body().then(b => runOwnedAction(s, owner, id, { key: b.key, action: b.action })).catch(unsettled),
  'GET operations': (s, owner, [id = '']) => agentOperations(s, owner, id),
  'GET access': (s, owner, [id = '']) => listAccessTokens(s, owner, id),
  'POST access': (s, owner, [id = ''], body) => body().then(b => createAccessToken(s, owner, id, b)),
  'POST access-revoke': (s, owner, [id = '', token = '']) => revokeAccessToken(s, owner, id, token),
  'POST intent': (s, owner, [id = ''], body) => body().then(b => submitOwnerIntent(s, owner, id, b.signed_data)),
  'POST status': (s, owner, [id = '']) => ownerIntentStatus(s, owner, id),
};

const accessHandlers: Record<string, AccessHandler> = {
  'GET session': (s, access) => Promise.resolve(accessSession(s, access)),
  'GET agent': (s, access) => accessSummary(s, access),
  'GET rounds': s => accessRounds(s),
  'POST quote': (s, _access, body) => body().then(b => accessQuote(s, b)),
  'POST actions': (s, access, body) => body().then(b => runAccessAction(s, access, b)).catch(unsettled),
  'GET operations': (s, access) => accessOperations(s, access),
};

function ownerTarget(path: string): [string, string[]] | null {
  if (path === '/v1/agents') return ['agents', []];
  const token = tokenPath.exec(path);
  if (token) return ['access-revoke', [token[1]!, token[2]!]];
  const agent = agentPath.exec(path);
  if (agent) return [agent[2]!, [agent[1]!]];
  const intent = intentPath.exec(path);
  return intent ? [intent[2] ? 'status' : 'intent', [intent[1]!]] : null;
}

export function refusal(error: unknown): never {
  if (error instanceof InvalidAction) throw new ReadError(400, error.message);
  if (error instanceof Error && error.message === 'operation_idempotency_conflict') {
    throw new ReadError(409, error.message);
  }
  if (error instanceof Error && error.message === 'operation_state_conflict') {
    throw new ReadError(409, 'operation_in_progress');
  }
  if (error instanceof AgentApiUnavailable) throw new ReadError(502, 'agent_api_unavailable');
  if (!(error instanceof AgentApiError)) throw error;
  if (error.status === 429) throw new ReadError(429, 'agent_api_rate_limited');
  if (error.status >= 400 && error.status < 500 && ![401, 408].includes(error.status)) {
    throw new ReadError(409, refusalCode(error));
  }
  throw new ReadError(502, 'agent_api_unavailable');
}

const notAllowed = () => Promise.reject(new ReadError(405, 'method_not_allowed'));

export function createAgentRoutes(s: AgentAccounts): AgentRoutes {
  return {
    owner: (method, path, owner, body) => {
      const found = ownerTarget(path), handler = found && ownerHandlers[`${method} ${found[0]}`];
      return found && handler ? handler(s, owner, found[1], body).catch(refusal) : notAllowed();
    },
    access: (method, path, authorization, body) => {
      const name = accessPath.exec(path)?.[1], handler = name && accessHandlers[`${method} ${name}`];
      return handler ? accessFor(s, authorization).then(access => handler(s, access, body)).catch(refusal)
        : notAllowed();
    },
  };
}
