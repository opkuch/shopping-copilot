// One function per route. Each returns a discriminated union, so the reducer switches on `kind`
// and never inspects status codes. Nothing here throws.
import type { ConversationListItem, ConversationView, Preview, Stage, TurnResponse } from "./types.ts";

export type Failure =
  | { kind: "conflict"; conversation: ConversationView }
  | { kind: "reply_failed"; conversationId: string; revision: number; userMessageId: string }
  | { kind: "storage_failed"; message: string }
  | { kind: "internal"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "not_found"; message: string }
  /** No usable answer: fetch threw, timed out, or the body was not the JSON we expect. */
  | { kind: "network"; message: string }
  /** The caller aborted (navigation, effect cleanup). Callers dispatch nothing. */
  | { kind: "aborted" };

export type Result<T> = { ok: true; data: T } | ({ ok: false } & Failure);

export type ConversationList = { conversations: ConversationListItem[]; warning: string | null };
export type CreateBody = { messageId: string; text: string };
/** `productId`: a click on a card names the product it asks about. */
export type SendBody = CreateBody & { revision: number; productId?: number };

export type ApiClient = {
  listConversations(signal?: AbortSignal): Promise<Result<ConversationList>>;
  getConversation(id: string, signal?: AbortSignal): Promise<Result<ConversationView>>;
  createConversation(body: CreateBody, signal?: AbortSignal): Promise<Result<TurnResponse>>;
  sendMessage(conversationId: string, body: SendBody, signal?: AbortSignal): Promise<Result<TurnResponse>>;
  /** `preview`: the cards and template sentence, once retrieval is done (cards first). */
  getProgress(messageId: string, signal?: AbortSignal): Promise<Result<{ stage: Stage; preview?: Preview | null }>>;
};

export type ClientOptions = {
  fetch?: typeof fetch;
  /** A turn may take the server's full 25 s deadline; give it headroom. */
  turnTimeoutMs?: number;
  readTimeoutMs?: number;
};

type ErrorBody = { error?: { code?: unknown; message?: unknown }; [k: string]: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Maps a non-2xx JSON body to a Failure by its error code. Anything unrecognized is `network`. */
export function toFailure(status: number, body: unknown): Failure {
  const b: ErrorBody = isObject(body) ? body : {};
  const code = isObject(b.error) ? b.error.code : undefined;
  const message = isObject(b.error) && typeof b.error.message === "string" ? b.error.message : `HTTP ${status}`;
  switch (code) {
    case "revision_conflict":
      if (isObject(b.conversation)) return { kind: "conflict", conversation: b.conversation as ConversationView };
      break;
    case "reply_failed":
      if (typeof b.conversationId === "string" && typeof b.revision === "number" && typeof b.userMessageId === "string") {
        return { kind: "reply_failed", conversationId: b.conversationId, revision: b.revision, userMessageId: b.userMessageId };
      }
      break;
    case "storage_failed":
    case "internal":
    case "validation":
    case "not_found":
      return { kind: code, message };
    case "rate_limited":
      // Not stored: shown like a validation refusal (toast, text back in the box).
      return { kind: "validation", message };
  }
  return { kind: "network", message: `Unexpected response (HTTP ${status}).` };
}

export function createApiClient(opts: ClientOptions = {}): ApiClient {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const turnTimeoutMs = opts.turnTimeoutMs ?? 35_000;
  const readTimeoutMs = opts.readTimeoutMs ?? 10_000;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<Result<T>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(path, {
        method,
        signal: combined,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (signal?.aborted) return { ok: false, kind: "aborted" };
      if (timeout.aborted) return { ok: false, kind: "network", message: "The server took too long to answer." };
      return { ok: false, kind: "network", message: "Couldn't reach the server." };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (signal?.aborted) return { ok: false, kind: "aborted" };
      return { ok: false, kind: "network", message: `Unexpected response (HTTP ${res.status}).` };
    }
    if (signal?.aborted) return { ok: false, kind: "aborted" };
    if (res.ok) return { ok: true, data: json as T };
    return { ok: false, ...toFailure(res.status, json) };
  }

  const enc = encodeURIComponent;
  return {
    listConversations: (signal) => call("GET", "/api/conversations", readTimeoutMs, signal),
    getConversation: (id, signal) => call("GET", `/api/conversations/${enc(id)}`, readTimeoutMs, signal),
    createConversation: (body, signal) => call("POST", "/api/conversations", turnTimeoutMs, signal, body),
    sendMessage: (id, body, signal) => call("POST", `/api/conversations/${enc(id)}/messages`, turnTimeoutMs, signal, body),
    getProgress: (messageId, signal) => call("GET", `/api/messages/${enc(messageId)}/progress`, readTimeoutMs, signal),
  };
}

export const api = createApiClient();
