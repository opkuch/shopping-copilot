import type { Preview, Stage } from "../messages/schema.ts";
import type { TurnOutcome } from "./ports.ts";

// Process-local on purpose: two server processes are not supported.
// The same object owns the lock and the progress stage, so "is it running" and
// "what is it doing" can never disagree.
export interface TurnLocks {
  /** Joins the run in flight for `id`, or starts `work` and remembers it until it settles. */
  run(id: string, work: (setStage: (stage: Stage) => void, setPreview: (preview: Preview) => void) => Promise<TurnOutcome>): Promise<TurnOutcome>;
  stage(id: string): Stage;
  /** The cards decided so far for the run in flight, or null (none yet, or no run). */
  preview(id: string): Preview | null;
}

export function createLocks(): TurnLocks {
  const inflight = new Map<string, Promise<TurnOutcome>>();
  const stages = new Map<string, Stage>();
  const previews = new Map<string, Preview>();

  return {
    run(id, work) {
      const existing = inflight.get(id);
      if (existing) return existing;

      stages.set(id, "classifying");
      // async wrapper: a synchronous throw in `work` becomes a rejection, not a leaked lock
      const promise = (async () => work((stage) => void stages.set(id, stage), (preview) => void previews.set(id, preview)))();
      inflight.set(id, promise);
      const release = () => {
        if (inflight.get(id) === promise) {
          inflight.delete(id);
          stages.delete(id);
          previews.delete(id);
        }
      };
      promise.then(release, release);
      return promise;
    },
    stage(id) {
      return stages.get(id) ?? "idle";
    },
    preview(id) {
      return previews.get(id) ?? null;
    },
  };
}
