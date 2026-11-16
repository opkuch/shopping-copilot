// A cap on new turns, because every turn makes paid model calls: a runaway client (a stuck retry loop, a
// script) must not run up the bill. Sliding windows in memory, per conversation and for the whole
// process (the server binds to loopback, so there is one user and no per-IP key worth having).
// Resends of a message already accepted are not counted: they join the run in flight and cost nothing.

export type RateLimiter = {
  /** True when one more new turn fits; it is then counted. `key` is the conversation id, or "new". */
  allow(key: string): boolean;
  /** Seconds until the oldest counted turn leaves the window that is full. */
  retryAfter(key: string): number;
};

export function createRateLimiter(opts: { perConversation?: number; total?: number; windowMs?: number; now?: () => number } = {}): RateLimiter {
  const perConversation = opts.perConversation ?? 12;
  const total = opts.total ?? 40;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const byKey = new Map<string, number[]>();
  const all: number[] = [];
  const prune = (list: number[], t: number) => {
    while (list.length > 0 && t - (list[0] as number) >= windowMs) list.shift();
  };
  return {
    allow(key) {
      const t = now();
      const mine = byKey.get(key) ?? [];
      prune(mine, t);
      prune(all, t);
      if (mine.length >= perConversation || all.length >= total) return false;
      mine.push(t);
      all.push(t);
      byKey.set(key, mine);
      return true;
    },
    retryAfter(key) {
      const t = now();
      const mine = byKey.get(key) ?? [];
      const full = mine.length >= perConversation ? mine : all;
      const oldest = full[0];
      return oldest === undefined ? 1 : Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000));
    },
  };
}
