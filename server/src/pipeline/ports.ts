// Interfaces between modules. The orchestrator depends only on these; tests pass fakes.
// Production bindings: OpenAI adapters (router/, slots/, reply/) and DummyJSON adapter (retrieval/).
import type {
  ExtractedIntent, ExtractionResult, Group, Payload, ProductCard, ProductDetail, Query, RouterResult,
} from "../messages/schema.ts";

// ---------- Budget (25 s turn deadline) ----------
export interface Budget {
  /** ms left in the turn; never negative */
  remaining(): number;
  /** min(callTimeoutMs, remaining()) */
  timeoutFor(callTimeoutMs: number): number;
}

// ---------- Trace ----------
// Each module appends plain JSON-serializable facts. Never put keys or headers here.
export interface TraceSink {
  event(kind: string, data: Record<string, unknown>): void;
}

// ---------- Typed failures crossing a port ----------
// A call that failed after the retry policy (timeout, HTTP error, connection error).
export class CallFailed extends Error {
  readonly kind: "timeout" | "http" | "network" | "parse";
  readonly status: number | null;
  constructor(kind: "timeout" | "http" | "network" | "parse", message: string, status: number | null = null) {
    super(message);
    this.name = "CallFailed";
    this.kind = kind;
    this.status = status;
  }
}

// ---------- Model ports ----------
export type ShownCard = { index: number; id: number; title: string; category: string; price: number };
export type StoredQuery = { label: string; query: Query };

export type RouterInput = {
  utterance: string;
  storedQueries: StoredQuery[]; // 0..2, in group order
  shownCards: ShownCard[]; // flattened group 1 then group 2, 1-based index
  /**
   * The exchange just before this message, so a short answer ("the laptops", "yes, in black")
   * can be read against the question it answers. Context only: the stored queries stay authoritative.
   */
  previous?: { user: string; assistant: string } | null;
  /** What the conversation is about beyond the last exchange (a gift for her; rejected: jewellery). */
  memory?: import("../messages/schema.ts").ConversationMemory | null;
};
export interface RouterClient {
  /** Throws CallFailed on failure. Refusals are returned in RouterResult, never thrown. */
  route(input: RouterInput, ctx: { budget: Budget; trace: TraceSink; signal?: AbortSignal }): Promise<RouterResult>;
}

export type ExtractInput = RouterInput;
export interface SlotClient {
  /** Throws CallFailed on failure. Aborting via signal rejects with an AbortError. */
  extract(input: ExtractInput, ctx: { budget: Budget; trace: TraceSink; signal?: AbortSignal }): Promise<ExtractionResult>;
}

type Lang = import("../reply/language.ts").Lang;

/** One group as the reply writer sees it: what was asked, what code decided, and the cards in order. */
export type ResultFacts = {
  label: string;
  outcome: "results" | "no_match" | "could_not_load";
  /** How the cards relate to the request: exact, or which words were dropped to find anything. */
  match: import("../messages/schema.ts").Match;
  droppedWords: string[];
  /** The refine found nothing, so the cards below are the earlier ones, unchanged. */
  earlierCardsKept: boolean;
  totalMatches: number;
  /** topIsFirst: the user asked for the single cheapest / priciest / best-rated: card 1 is the answer, the rest runners-up. */
  request: { priceMin: number | null; priceMax: number | null; sort: string; inStockOnly: boolean; topIsFirst: boolean };
  cards: Array<{ position: number; title: string; category: string; price: number; rating: number; inStock: boolean }>;
};

/**
 * Refer: phrase one product's detail. Results: answer the user's message from the decided facts.
 * Code chooses every product and number; the model only words the reply, and `draft` (the template)
 * is what is shown whenever the model fails or its reply cannot be checked against the facts.
 */
export type ProseInput =
  | { kind: "refer"; detail: ProductDetail; language: Lang; message: string }
  | {
    kind: "results";
    language: Lang;
    message: string;
    previous: { user: string; assistant: string } | null;
    draft: string;
    groups: ResultFacts[];
  };
export type TurnFlags = {
  droppedIntents: boolean;
  mentionsService: boolean;
  currencyNotApplied: boolean;
  /** A bound was given in shekels and converted at ILS_PER_USD; the reply states the rate. */
  currencyConverted: boolean;
  secondPatchIgnored: boolean;
  noCheaper: { price: number } | null;
  noPricier: { price: number } | null;
};
export interface ReplyWriter {
  /** Returns plain text, or null when the call failed, timed out, was skipped, or exceeded 400 chars. Never throws. */
  write(input: ProseInput, ctx: { budget: Budget; trace: TraceSink }): Promise<string | null>;
}

// ---------- Catalog ----------
// Raw DummyJSON product as selected (select=title,description,price,thumbnail,rating,category,stock,brand,tags).
// brand and tags are optional: DummyJSON omits brand on groceries and some clothing.
export type RawProduct = {
  id: number;
  title: string;
  description: string;
  price: number;
  thumbnail: string;
  rating: number;
  category: string;
  stock: number;
  brand?: string;
  tags?: string[];
  discountPercentage?: number;
};
export type RawProductFull = RawProduct & {
  availabilityStatus?: string;
  warrantyInformation?: string;
  shippingInformation?: string;
  returnPolicy?: string;
  reviews?: unknown[];
};
export type CategoryInfo = { slug: string; name: string };

/** Low-level HTTP surface of DummyJSON. Each method throws CallFailed after its retry policy. */
export interface CatalogApi {
  byCategory(slug: string, ctx: CallCtx): Promise<{ products: RawProduct[]; endpoint: string }>;
  search(q: string, ctx: CallCtx): Promise<{ products: RawProduct[]; endpoint: string }>;
  all(ctx: CallCtx): Promise<{ products: RawProduct[]; endpoint: string }>;
  product(id: number, ctx: CallCtx): Promise<RawProductFull>;
  categories(ctx: CallCtx): Promise<CategoryInfo[]>;
}
export type CallCtx = { budget: Budget; trace: TraceSink };

/** Normalized query handed to retrieval, after merge and normalization. `categoryStated` is part of Query. */
export type RetrievalQuery = Query;

export type RetrievalResult = {
  status: "results" | "miss";
  match: import("../messages/schema.ts").Match;
  products: ProductCard[]; // first 4
  total: number;
  /** The query actually applied (category null after noun_outside_category). */
  applied: Query;
};
export type RetrieveOptions = {
  /**
   * false on "cheaper"/"pricier": the user wants the same thing at another price, so the ladder may
   * not drop the noun for other products in the category. Default true.
   */
  mayDropNoun?: boolean;
  /** true on "cheaper"/"pricier": only exact matches; no step of the ladder relaxes anything. */
  exactOnly?: boolean;
  /** The gender came from context (a gift question), not from this message: dropped if it leaves nothing. */
  genderInherited?: boolean;
};
export interface Retriever {
  /** Throws CallFailed when the needed fetch failed and no stale cache entry exists. */
  retrieve(query: RetrievalQuery, ctx: CallCtx, opts?: RetrieveOptions): Promise<RetrievalResult>;
}

/** Category display names; null until the list has ever loaded. */
export interface CategoryNames {
  names(ctx: CallCtx): Promise<CategoryInfo[] | null>;
}

// ---------- Store ----------
export type AcceptResult =
  | { kind: "accepted"; conversationId: string; revision: number; userMessage: { id: string; text: string; createdAt: string } }
  | { kind: "conflict"; conversation: import("../messages/schema.ts").ConversationView }
  | { kind: "exists"; conversationId: string; messageId: string } // resend path; caller inspects state
  | { kind: "not_found" }
  | { kind: "text_mismatch" };

export type ResendState =
  | { kind: "answered"; conversationId: string; revision: number; userMessage: { id: string; text: string; createdAt: string }; assistantMessage: import("../messages/schema.ts").AssistantMessage }
  | { kind: "unanswered_tail"; conversationId: string; revision: number; userMessage: { id: string; text: string; createdAt: string } }
  | { kind: "not_tail"; conversation: import("../messages/schema.ts").ConversationView };

export type StoreAssistantResult =
  | { kind: "stored"; assistantMessage: import("../messages/schema.ts").AssistantMessage }
  | { kind: "dropped"; reason: "conversation_gone" | "not_tail" };

export interface Store {
  /** New conversation with its first user message (revision 0 -> 1). */
  acceptFirst(messageId: string, text: string): AcceptResult;
  /** User message in an existing conversation. Idempotency check precedes the revision check. */
  acceptMessage(conversationId: string, messageId: string, text: string, revision: number): AcceptResult;
  resendState(messageId: string): ResendState | null;
  storeAssistant(args: {
    conversationId: string;
    userMessageId: string;
    text: string;
    payload: Payload | null;
    trace: { attempt: number; trace: unknown };
  }): StoreAssistantResult;
  /** Best effort; never throws. */
  recordFailedTrace(userMessageId: string, attempt: number, outcome: "reply_failed" | "dropped", trace: unknown): void;
  nextAttempt(userMessageId: string): number;
  getConversation(id: string): import("../messages/schema.ts").ConversationView | null;
  listConversations(): { conversations: import("../messages/schema.ts").ConversationListItem[]; warning: string | null };
  /**
   * The user message and reply just before the tail (the message being answered), and the change the
   * reply left pending ("Which one should I change?"). null for a first message.
   */
  previousExchange(conversationId: string): { user: string; assistant: string; pending: ExtractedIntent[] | null; purpose: import("../messages/schema.ts").PurposeContext | null; memory: import("../messages/schema.ts").ConversationMemory | null } | null;
  /** Latest assistant message with >=1 group (readable). null => next product turn is a new search. */
  workingQuery(conversationId: string): { messageId: string; groups: Group[] } | null;
  traces(userMessageId: string): Array<{ id: string; attempt: number; outcome: string; trace: unknown; createdAt: string }>;
}

export type { ProductCard };

// ---------- Turn runner (orchestrator ↔ routes) ----------
export type TurnOutcome =
  | { kind: "completed"; response: import("../messages/schema.ts").TurnResponse }
  /** User message is saved, reply is not (model/catalog failure, or disk full on the assistant write). → 503 */
  | { kind: "reply_failed"; conversationId: string; revision: number; userMessageId: string }
  /** Assistant write found nothing to append to (→ 404) or the message is no longer the tail (→ 409 with transcript). */
  | { kind: "dropped"; reason: "conversation_gone" | "not_tail" };

export interface TurnRunner {
  /**
   * Runs (or joins) the pipeline for an accepted, unanswered user message.
   * Idempotent per userMessage.id inside this process: a second call while the first is in flight
   * returns the same promise (the per-message lock), so a resend never duplicates model calls.
   * Never throws for model/catalog/storage failures; those become outcomes.
   */
  run(args: {
    conversationId: string;
    revision: number;
    userMessage: { id: string; text: string; createdAt: string };
  }): Promise<TurnOutcome>;
  /** Current pipeline stage for an in-flight message; "idle" when nothing is running for it. */
  stage(userMessageId: string): import("../messages/schema.ts").Stage;
  preview(userMessageId: string): import("../messages/schema.ts").Preview | null;
}
