import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { CallFailed } from "../pipeline/ports.ts";
import type { Budget, TraceSink } from "../pipeline/ports.ts";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_CAP_MS = 2000;
// A retry that has under one second left cannot finish a real call, so it would only
// burn the turn's last moments and hide the first error behind a timeout.
const MIN_NEXT_ATTEMPT_MS = 1000;

export function statusOf(err: unknown): number | null {
  return err instanceof APIError && typeof err.status === "number" ? err.status : null;
}

function retryAfterMs(err: unknown): number {
  if (!(err instanceof APIError)) return 0;
  const raw = err.headers?.get("retry-after");
  const seconds = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(RETRY_AFTER_CAP_MS, Math.round(seconds * 1000));
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof APIConnectionTimeoutError) return false;
  if (err instanceof APIConnectionError) return true;
  const code = (err as { code?: unknown } | null)?.code ?? (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === "ECONNRESET") return true;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** Rejects when `signal` aborts, so a fn that ignores its signal still cannot outlive its timeout. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CallOpts = {
  name: string;
  timeoutMs: number;
  budget: Budget;
  trace: TraceSink;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

export async function callWithRetry<T>(fn: (signal: AbortSignal) => Promise<T>, opts: CallOpts): Promise<T> {
  const { name, budget, trace, signal: caller } = opts;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    const timeoutSignal = AbortSignal.timeout(budget.timeoutFor(opts.timeoutMs));
    const signal = caller ? AbortSignal.any([timeoutSignal, caller]) : timeoutSignal;
    const started = performance.now();
    const record = (outcome: string, status: number | null = null) =>
      trace.event("llm_attempt", { name, attempt, ms: Math.round(performance.now() - started), outcome, status });

    try {
      const result = await raceAbort(fn(signal), signal);
      record("ok");
      return result;
    } catch (err) {
      if (caller?.aborted) {
        record("aborted");
        throw err;
      }
      if (err instanceof CallFailed) {
        record(err.kind, err.status);
        throw err;
      }
      const status = statusOf(err);
      if (timeoutSignal.aborted || err instanceof APIConnectionTimeoutError) {
        record("timeout");
        throw new CallFailed("timeout", `${name} timed out`);
      }

      const retryable = (status !== null && RETRY_STATUS.has(status)) || (status === null && isConnectionError(err));
      const kind = status !== null ? "http" : "network";
      const message = err instanceof Error ? err.message : String(err);
      const wait = retryable ? retryAfterMs(err) : 0;
      if (!retryable || attempt >= 2 || budget.remaining() < wait + MIN_NEXT_ATTEMPT_MS) {
        record(kind, status);
        throw new CallFailed(kind, `${name} failed: ${message}`, status);
      }
      record(kind, status);
      if (wait > 0) await sleep(wait);
      if (caller?.aborted) throw caller.reason;
    }
  }
}
