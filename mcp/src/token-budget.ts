import { createHash } from 'node:crypto';

const WINDOW_MS = 60000;
const NEW_TOKENS_PER_WINDOW = 600;
const MAX_GOOD_TOKENS = 10000;

const digest = (token: string) => createHash('sha256').update(token).digest('base64');

export class TokenBudget {
  private readonly good = new Set<string>();
  private started = 0;
  private spent = 0;

  constructor(private readonly perWindow = NEW_TOKENS_PER_WINDOW, private readonly now = Date.now) {}

  allows(token: string) {
    if (this.good.has(digest(token))) return true;
    const at = this.now();
    if (at - this.started >= WINDOW_MS) {
      this.started = at;
      this.spent = 0;
    }
    return ++this.spent <= this.perWindow;
  }

  accepted(token: string) {
    const key = digest(token);
    this.good.delete(key);
    this.good.add(key);
    if (this.good.size > MAX_GOOD_TOKENS) this.good.delete(this.good.values().next().value!);
  }

  refused(token: string) {
    this.good.delete(digest(token));
  }
}
