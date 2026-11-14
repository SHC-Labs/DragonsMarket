import { config } from "./config";
import { relayedIntentSucceeded } from "./receipt-proof";
import { UserFacingError } from "./errors";
import { RelayError, type Attempt, type Relayed } from "./relay";

export async function confirmRelayed(sent: Relayed, opts: {
  read: (hash: string) => Promise<unknown>;
  done: () => Promise<boolean>;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  if (sent.hashes.length === 0 || sent.hashes.length !== sent.items.length) return false;
  const proved = new Set<number>();
  const deadline = now() + opts.timeoutMs;
  while (now() < deadline) {
    await sleep(1500);
    try {
      for (let i = 0; i < sent.hashes.length; i++) {
        if (proved.has(i)) continue;
        const { standard, payload, target } = sent.items[i];
        if (relayedIntentSucceeded(await opts.read(sent.hashes[i]), sent.hashes[i], config.relayerId, config.verifierId, { standard, payload }, target)) proved.add(i);
      }
      if (proved.size === sent.hashes.length && await opts.done()) return true;
    } catch {
      // a read failed; try again until the deadline
    }
  }
  return false;
}


export function oneAtATime() {
  let busy = false;
  return async (fn: () => Promise<boolean>): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };
}

export type RelayOutcome =
  | { phase: "done" | "failed"; message: string }
  | { phase: "unknown"; message: string; attempt: Attempt | null };

interface OutcomeOptions {
  read: (hash: string) => Promise<unknown>;
  done: () => Promise<boolean>;
  doneMessage: string;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// A server refusal, elapsed deadline or missing receipt cannot disprove an earlier
// execution. Only the exact successful receipt graph releases a pending action.
export async function relayOutcome(go: () => Promise<Relayed>, o: OutcomeOptions): Promise<RelayOutcome> {
  let sent: Relayed | null = null;
  let attempt: Attempt | null = null;
  try {
    sent = await go();
    attempt = sent.attempt ?? null;
  } catch (error) {
    if (!(error instanceof RelayError)) return { phase: "failed",
      message: error instanceof UserFacingError ? error.message : "The request could not be confirmed. Check for a saved request before trying again." };
    attempt = error.attempt ?? null;
    const hashes = attempt?.hashes ?? [...error.completed, ...(error.hash ? [error.hash] : [])];
    if (attempt && hashes.length === attempt.items.length) sent = { hashes, items: attempt.items, attempt };
  }
  if (sent && await confirmRelayed(sent, o)) return { phase: "done", message: o.doneMessage };
  return { phase: "unknown", attempt,
    message: "The outcome is not confirmed. Use Check again to recover the same signed request without signing a second action." };
}
