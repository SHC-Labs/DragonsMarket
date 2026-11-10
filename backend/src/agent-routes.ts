import { ReadError } from './read-api.js';
import { AgentApiError, AgentApiUnavailable, refusalCode } from './agent-api.js';
import { InvalidAction } from './agent-actions.js';
import { OperationRefused } from './operations.js';
import {
  agentClaimable, agentOperations, createAgent, freezeAgent, issueGrant, listAgents, ownerIntentStatus,
  parseOwnedAction, revokeGrants, runOwnedAction, sessionLimits, submitOwnerIntent, type AgentAccounts,
} from './agent-accounts.js';
import {
  accessClaimable, accessFor, accessMarkets, accessOperations, accessPolicy, accessPositions, accessQuote, accessQuoteBuy,
  accessQuoteSell, accessRounds, accessSession, accessSummary, listAccessTokens, requestAccess, revokeAccessToken,
  runAccessAction, signAccess, type Access,
} from './agent-access.js';
import { accessPath, agentPath, intentPath, tokenPath, type AgentRoutes, type Body, type Owner } from './agent-paths.js';

type OwnerHandler = (s: AgentAccounts, owner: Owner, ids: string[], body: Body) => Promise<unknown>;
type AccessHandler = (s: AgentAccounts, access: Access, body: Body) => Promise<unknown>;

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
  'POST actions': (s, owner, [id = ''], body) => body().then(b => runOwnedAction(s, owner, id,
    { key: b.key, action: parseOwnedAction(b.action, owner.account), limits: sessionLimits(s, owner) }))
    .catch(unsettled),
  'GET operations': (s, owner, [id = '']) => agentOperations(s, owner, id),
  'GET claimable': (s, owner, [id = '']) => agentClaimable(s, owner, id),
  'GET access': (s, owner, [id = '']) => listAccessTokens(s, owner, id),
  'POST access': (s, owner, [id = ''], body) => body().then(b => requestAccess(s, owner, id, b)),
  'POST access-sign': (s, owner, [id = '', token = ''], body) => body().then(b => signAccess(s, owner, id, token, b)),
  'POST access-revoke': (s, owner, [id = '', token = '']) => revokeAccessToken(s, owner, id, token),
  'POST intent': (s, owner, [id = ''], body) => body().then(b => submitOwnerIntent(s, owner, id, b.signed_data)),
  'POST status': (s, owner, [id = '']) => ownerIntentStatus(s, owner, id),
};

const accessHandlers: Record<string, AccessHandler> = {
  'GET session': (s, access) => Promise.resolve(accessSession(s, access)),
  'GET agent': (s, access) => accessSummary(s, access),
  'GET policy': (s, access) => accessPolicy(s, access),
  'GET rounds': s => accessRounds(s),
  'POST quote': (s, _access, body) => body().then(b => accessQuote(s, b)),
  'GET markets': s => accessMarkets(s),
  'POST markets': (s, _access, body) => body().then(b => accessMarkets(s, b.from_market)),
  'GET positions': (s, access) => accessPositions(s, access),
  'POST quote-buy': (s, _access, body) => body().then(b => accessQuoteBuy(s, b)),
  'POST quote-sell': (s, _access, body) => body().then(b => accessQuoteSell(s, b)),
  'POST actions': (s, access, body) => body().then(b => runAccessAction(s, access, b)).catch(unsettled),
  'GET operations': (s, access) => accessOperations(s, access),
  'GET claimable': (s, access) => accessClaimable(s, access),
};

function ownerTarget(path: string): [string, string[]] | null {
  if (path === '/v1/agents') return ['agents', []];
  const token = tokenPath.exec(path);
  if (token) return [`access-${token[3]!}`, [token[1]!, token[2]!]];
  const agent = agentPath.exec(path);
  if (agent) return [agent[2]!, [agent[1]!]];
  const intent = intentPath.exec(path);
  return intent ? [intent[2] ? 'status' : 'intent', [intent[1]!]] : null;
}

export function refusal(error: unknown): never {
  if (error instanceof InvalidAction) throw new ReadError(400, error.message);
  if (error instanceof OperationRefused) {
    throw new ReadError(409, error.message === 'operation_state_conflict' ? 'operation_in_progress' : error.message);
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
