import type { Budget } from "./ports.ts";

// One budget per turn. `now` is injectable so tests can pass a hand-driven clock.
export function createBudget(totalMs = 25_000, now: () => number = () => performance.now()): Budget {
  const start = now();
  const remaining = () => Math.max(0, totalMs - (now() - start));
  return {
    remaining,
    // Whole ms: AbortSignal.timeout rejects fractions.
    timeoutFor: (callTimeoutMs) => Math.floor(Math.min(callTimeoutMs, remaining())),
  };
}
