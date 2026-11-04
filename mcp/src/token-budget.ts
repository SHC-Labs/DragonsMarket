import { createHash } from 'node:crypto';

const WINDOW_MS = 60000;
const NEW_TOKENS_PER_WINDOW = 600;
const REQUESTS_PER_TOKEN = 60;
const MAX_GOOD_TOKENS = 10000;

interface Use { started: number; count: number }

const digest = (token: string) => createHash('sha256').update(token).digest('base64');

export class TokenBudget {
  private readonly good = new Map<string, Use>();
  private readonly fresh: Use = { started: 0, count: 0 };

  constructor(private readonly newPerWindow = NEW_TOKENS_PER_WINDOW, private readonly perToken = REQUESTS_PER_TOKEN,
    private readonly now = Date.now) {}

  private within(use: Use, most: number) {
    const at = this.now();
    if (at - use.started >= WINDOW_MS) {
      use.started = at;
      use.count = 0;
    }
    return ++use.count <= most;
  }

  allows(token: string) {
    const known = this.good.get(digest(token));
    return known ? this.within(known, this.perToken) : this.within(this.fresh, this.newPerWindow);
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
