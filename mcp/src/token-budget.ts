import { createHash } from 'node:crypto';

const WINDOW_MS = 60000;
const NEW_TOKENS_PER_WINDOW = 60;
const REQUESTS_PER_TOKEN = 60;
const MAX_GOOD_TOKENS = 10000;

interface Use { started: number; count: number }
interface Caller extends Use { pending: number }

const digest = (token: string) => createHash('sha256').update(token).digest('base64');

export class TokenBudget {
  private readonly good = new Map<string, Use>();
  private readonly callers = new Map<string, Caller>();
  private pending = 0;

  constructor(private readonly options: { newPerWindow?: number; perToken?: number; now?: () => number;
    maxCallers?: number; maxPending?: number; pendingPerCaller?: number } = {}) {}

  private now() { return (this.options.now ?? Date.now)(); }

  private within(use: Use, most: number) {
    const at = this.now();
    if (at - use.started >= WINDOW_MS) {
      use.started = at;
      use.count = 0;
    }
    return ++use.count <= most;
  }

  // A lease bounds concurrent session checks as well as their rate. Never evict
  // an active caller: rotating identities must not reset an exhausted budget.
  acquire(token: string, client: string): (() => void) | undefined {
    let caller = this.callers.get(client);
    if (!caller) {
      if (this.callers.size >= (this.options.maxCallers ?? 10000)) {
        const now = this.now();
        for (const [key, value] of this.callers) {
          if (!value.pending && now - value.started >= WINDOW_MS) this.callers.delete(key);
        }
        if (this.callers.size >= (this.options.maxCallers ?? 10000)) return;
      }
      caller = { started: this.now(), count: 0, pending: 0 };
      this.callers.set(client, caller);
    }
    if (this.pending >= (this.options.maxPending ?? 32) || caller.pending >= (this.options.pendingPerCaller ?? 4)) return;
    const known = this.good.get(digest(token));
    if (!this.within(known ?? caller, known ? (this.options.perToken ?? REQUESTS_PER_TOKEN)
      : (this.options.newPerWindow ?? NEW_TOKENS_PER_WINDOW))) return;
    caller.pending++;
    this.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      caller.pending--;
      this.pending--;
    };
  }

  accepted(token: string) {
    const key = digest(token), use = this.good.get(key) ?? { started: this.now(), count: 1 };
    this.good.delete(key);
    this.good.set(key, use);
    if (this.good.size > MAX_GOOD_TOKENS) this.good.delete(this.good.keys().next().value!);
  }

  refused(token: string) {
    this.good.delete(digest(token));
  }
}
