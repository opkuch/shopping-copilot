// What every action of a turn shares: the dependencies, the trace, and the three ways a turn ends (commit a
// reply, fail, or answer with a fixed template). runTurn.ts builds it.
import type { ConversationMemory, ExtractedIntent, Group, Payload, Preview, Query, Stage, Suggestion } from "../messages/schema.ts";
import { CallFailed } from "./ports.ts";
import type {
  CallCtx, CatalogApi, CategoryInfo, CategoryNames, ReplyWriter, Retriever, RouterClient, SlotClient, Store, TraceSink, TurnOutcome,
} from "./ports.ts";

export type TurnDeps = {
  store: Store;
  router: RouterClient;
  slots: SlotClient;
  retriever: Retriever;
  categories: CategoryNames;
  /** Only for product details; list retrieval goes through `retriever`. */
  catalog: CatalogApi;
  writer: ReplyWriter;
  now?: () => number;
  turnMs?: number;
};

export type Turn = {
  deps: TurnDeps;
  ctx: CallCtx;
  trace: TraceSink;
  /** The turn's facts for the trace (GET /api/messages/:id/trace). */
  summary: Record<string, unknown>;
  text: string;
  setStage(stage: Stage): void;
  setPreview(preview: Preview): void;
  /** Cancels extraction once the turn knows it will not need it. */
  extractAbort: AbortController;
  /** The previous exchange and the conversation memory, read from the store at the start of the turn. */
  lastExchange: { user: string; assistant: string } | null;
  memory: ConversationMemory | null;
  commit(text: string, payload: Payload | null): TurnOutcome;
  failed(reason: string, err?: unknown): TurnOutcome;
  /** A fixed reply with no model call; chips are the next steps to offer under it. */
  template(reason: string, text: string, chips?: Suggestion[]): TurnOutcome;
  /** Category display names. A load failure means "no names", never a failed turn. */
  loadNames(): Promise<CategoryInfo[] | null>;
};

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
export async function settle<T>(f: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (error) {
    return { ok: false, error };
  }
}

export const describe = (err: unknown) =>
  err instanceof CallFailed ? { kind: err.kind, status: err.status, message: err.message }
  : err instanceof Error ? { kind: "error", message: err.message }
  : { kind: "error", message: String(err) };

// An intent that says nothing: used when extraction found no intent, and to re-run a refine unchanged.
export const EMPTY_INTENT: ExtractedIntent = {
  category: null, noun: null, attributes: null, priceMin: null, priceMax: null,
  currency: null, relativePrice: null, sort: null, inStock: null, clear: [], exclude: null, gift: null,
};

/** An intent that changes nothing: every slot null and nothing cleared. */
export function isEmptyIntent(i: ExtractedIntent): boolean {
  return i.category === null && i.noun === null && (i.attributes ?? []).length === 0 && (i.exclude ?? []).length === 0 &&
    i.priceMin === null && i.priceMax === null && i.relativePrice === null && i.sort === null &&
    i.inStock === null && i.clear.length === 0;
}

/** Cards per group: four, and three (the best match and two alternatives) once a list puts three or more groups on screen. */
export const cardsPerGroup = (groups: number): number => (groups >= 3 ? 3 : 4);

/** The group without the drawing marks of the message it was stored in. */
export function withoutMarks(group: Group): Group {
  const { shownFrom: _shownFrom, repeat: _repeat, ...rest } = group;
  return rest;
}

/** A group carried forward unchanged: still the working query, drawn as one line ("still the matches"). */
export function asRepeat(group: Group): Group {
  return { ...withoutMarks(group), repeat: true };
}

/** The search a follow-up changes: what the user asked for, including words a relaxed match left out. */
export function requestedQuery(group: Group): Query {
  const dropped = group.dropped ?? [];
  if (dropped.length === 0) return group.query;
  return { ...group.query, attributes: [...new Set([...group.query.attributes, ...dropped])] };
}

/** The end of a turn: store the reply (or record why not) and shape the outcome for the route. */
export function createEndings(args: {
  store: Store;
  conversationId: string;
  revision: number;
  userMessage: { id: string; text: string; createdAt: string };
  summary: Record<string, unknown>;
  snapshot(outcome: string): unknown;
  attempt(): number;
  memory(): ConversationMemory | null;
  extractAbort: AbortController;
}): Pick<Turn, "commit" | "failed" | "template"> {
  const { store, conversationId, revision, userMessage, summary, snapshot } = args;

  // A failed trace insert must never hide the original failure, so recordFailedTrace is the only writer here.
  const failed = (reason: string, err?: unknown): TurnOutcome => {
    summary.failure = { reason, ...(err === undefined ? {} : describe(err)) };
    store.recordFailedTrace(userMessage.id, args.attempt(), "reply_failed", snapshot("reply_failed"));
    return { kind: "reply_failed", conversationId, revision, userMessageId: userMessage.id };
  };

  const commit = (text: string, payload: Payload | null): TurnOutcome => {
    let stored;
    try {
      stored = store.storeAssistant({
        conversationId, userMessageId: userMessage.id, text, payload,
        trace: { attempt: args.attempt(), trace: snapshot("completed") },
      });
    } catch (err) {
      // Disk full on the assistant save: the reply is not cached, a resend runs the pipeline again.
      return failed("assistant_write_failed", err);
    }
    if (stored.kind === "dropped") {
      summary.dropped = stored.reason;
      store.recordFailedTrace(userMessage.id, args.attempt(), "dropped", snapshot("dropped"));
      return { kind: "dropped", reason: stored.reason };
    }
    return {
      kind: "completed",
      response: {
        conversationId, revision,
        userMessage: { id: userMessage.id, role: "user", text: userMessage.text, createdAt: userMessage.createdAt },
        assistantMessage: stored.assistantMessage,
      },
    };
  };

  // Template replies end the turn without a model call; extraction is no longer needed. The memory is
  // carried over, so "thanks" between two requests doesn't forget that this is a gift for her.
  const template = (reason: string, text: string, chips: Suggestion[] = []): TurnOutcome => {
    args.extractAbort.abort();
    summary.template = reason;
    const memory = args.memory();
    if (chips.length === 0 && memory === null) return commit(text, null);
    return commit(text, { groups: [], detail: null, ...(chips.length > 0 ? { suggestions: chips } : {}), ...(memory ? { memory } : {}) });
  };

  return { commit, failed, template };
}
