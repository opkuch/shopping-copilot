// What every action of a turn shares: the dependencies, the trace, the reply language, and the three
// ways a turn ends (commit a reply, fail, or answer with a fixed template). runTurn.ts builds it.
import type { ConversationMemory, ExtractedIntent, Group, Payload, Preview, Stage } from "../messages/schema.ts";
import type { Templates } from "../reply/templates.ts";
import type { Lang } from "../reply/language.ts";
import { starterSuggestions } from "./purpose.ts";
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
  /** Only for the product detail fetch; list retrieval goes through `retriever`. */
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
  /** The reply's language follows this message, not the conversation: a user may switch mid-chat. */
  language: Lang;
  L: Templates;
  setStage(stage: Stage): void;
  setPreview(preview: Preview): void;
  /** Cancels extraction once the turn knows it will not need it. */
  extractAbort: AbortController;
  /** The previous exchange and the conversation memory, read from the store at the start of the turn. */
  lastExchange: { user: string; assistant: string } | null;
  memory: ConversationMemory | null;
  commit(text: string, payload: Payload | null): TurnOutcome;
  failed(reason: string, err?: unknown): TurnOutcome;
  template(reason: string, text: string): TurnOutcome;
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
  currency: null, relativePrice: null, sort: null, inStock: null, clear: [], gift: null, theme: null,
};

/** An intent that changes nothing: every slot null and nothing cleared. */
export function isEmptyIntent(i: ExtractedIntent): boolean {
  return i.category === null && i.noun === null && (i.attributes === null || i.attributes.length === 0) &&
    i.priceMin === null && i.priceMax === null && i.relativePrice === null && i.sort === null &&
    i.inStock === null && i.clear.length === 0;
}

/** The group without the drawing marks of the message it was stored in. */
export function withoutMarks(group: Group): Group {
  const { shownFrom: _shownFrom, repeat: _repeat, ...rest } = group;
  return rest;
}

/** A group carried forward unchanged: still the working query, drawn as one line ("still the matches"). */
export function asRepeat(group: Group): Group {
  return { ...withoutMarks(group), repeat: true };
}

/** The end of a turn: store the reply (or record why not) and shape the outcome for the route. */
export function createEndings(args: {
  store: Store;
  conversationId: string;
  revision: number;
  userMessage: { id: string; text: string; createdAt: string };
  language: Lang;
  summary: Record<string, unknown>;
  snapshot(outcome: string): unknown;
  attempt(): number;
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

  // Template replies end the turn without a model call; extraction is no longer needed.
  const template = (reason: string, text: string): TurnOutcome => {
    args.extractAbort.abort();
    summary.template = reason;
    // A reply that cannot help still offers a next step: example searches as chips.
    const starters = reason === "service" || reason === "off_topic";
    return commit(text, starters ? { groups: [], detail: null, suggestions: starterSuggestions(args.language) } : null);
  };

  return { commit, failed, template };
}
