// The app's shared state. Pure: every transition is a function call
// a test can make. Side effects (fetch, history, drafts) live in send.ts and effects.ts.
import type { ConversationListItem, ConversationView, Message, Preview, Stage, TurnResponse } from "../api/types.ts";
import type { Route } from "./router.ts";

export type ListState = {
  status: "loading" | "ready" | "error";
  items: ConversationListItem[];
  warning: string | null;
};

export type ConversationState =
  | { status: "none" }
  | { status: "loading"; id: string }
  | { status: "error"; id: string }
  | { status: "ready"; view: ConversationView };

/** One send, exactly as it goes over the wire. A retry resends the same object. */
export type Sent = {
  messageId: string;
  text: string;
  conversationId: string | null; // null for the first message of a new chat
  revision: number; // 0 for a new chat
};

/** What the client knows about an unanswered last message. */
export type TailState = { messageId: string; status: "checking" | "stalled" };

export type State = {
  route: Route;
  list: ListState;
  conversation: ConversationState;
  /** At most one send at a time, app-wide. */
  /** `preview`: the cards, shown before the reply sentence is written (cards first). */
  inflight: (Sent & { stage: Stage; preview?: Preview | null }) | null;
  /** A network failure: the server may never have received this message. */
  notSent: Sent | null;
  tail: TailState | null;
  /** Bumped when a draft is put back, so the composer remounts and reads it. */
  draftVersion: number;
  /** The id changes on every toast, so the same text twice is re-announced and re-timed. */
  toast: { id: number; text: string } | null;
  /** What a screen reader hears when a reply lands: the sentence plus a count per group. */
  announcement: { id: string; text: string } | null;
};

/**
 * One line per reply for the live region: the reply's sentence and "Dresses: 4 of 10 results".
 * The cards themselves are not read; they are in the transcript to browse.
 */
export function describeReply(message: TurnResponse["assistantMessage"]): string {
  const parts = [message.text];
  for (const g of message.groups) {
    if (g.status === "results") parts.push(`${g.label}: ${g.products.length} of ${g.total} results.`);
  }
  if (message.detail) parts.push(`Details for ${message.detail.title}.`);
  return parts.join(" ");
}

export type Action =
  | { type: "route_changed"; route: Route }
  | { type: "list_loading" }
  | { type: "list_loaded"; items: ConversationListItem[]; warning: string | null }
  | { type: "list_failed" }
  | { type: "conversation_loading"; id: string }
  | { type: "conversation_loaded"; view: ConversationView }
  | { type: "conversation_failed"; id: string }
  | { type: "conversation_not_found"; id: string }
  | { type: "send_started"; sent: Sent }
  | { type: "stage"; messageId: string; stage: Stage; preview?: Preview | null }
  | { type: "turn_completed"; sent: Sent; response: TurnResponse }
  | { type: "conflict"; sent: Sent; conversation: ConversationView }
  | { type: "send_failed"; sent: Sent }
  | { type: "not_sent"; sent: Sent }
  | { type: "tail_checking"; messageId: string }
  | { type: "tail_stalled"; messageId: string }
  | { type: "draft_restored" }
  | { type: "toast"; message: string }
  | { type: "toast_dismissed" };

export const NOT_FOUND_TOAST = "That conversation no longer exists.";

export const openId = (route: Route) => (route.view === "conversation" ? route.id : null);

/** The conversation state that matches a route, keeping what we already have for the same id. */
function conversationFor(route: Route, current: ConversationState): ConversationState {
  const id = openId(route);
  if (id === null) return { status: "none" };
  const currentId = current.status === "none" ? null : current.status === "ready" ? current.view.id : current.id;
  // A different id never shows the previous transcript, not even for one frame.
  return currentId === id ? current : { status: "loading", id };
}

export function initialState(route: Route): State {
  return {
    route,
    list: { status: "loading", items: [], warning: null },
    conversation: conversationFor(route, { status: "none" }),
    inflight: null,
    notSent: null,
    tail: null,
    draftVersion: 0,
    toast: null,
    announcement: null,
  };
}

/**
 * Upserts messages by id, keeping server order. The original POST, a resume resend, and a reload
 * can all deliver the same message; each lands once.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m] as const));
  const out = [...existing];
  for (const m of incoming) {
    if (byId.has(m.id)) {
      const i = out.findIndex((x) => x.id === m.id);
      out[i] = m;
    } else {
      out.push(m);
    }
    byId.set(m.id, m);
  }
  return out;
}

export const hasMessage = (view: ConversationView, messageId: string) => view.messages.some((m) => m.id === messageId);

const sameRoute = (a: Route, b: Route) => openId(a) === openId(b) && a.view === b.view;

/** The conversation a send belongs to is on screen: its id is open, or it is a new chat and we are home. */
export function isShowing(state: State, sent: Sent): boolean {
  return sent.conversationId === null ? state.route.view === "home" : openId(state.route) === sent.conversationId;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "route_changed": {
      if (sameRoute(state.route, action.route)) return state;
      // A "Not sent." message is forgotten when the user leaves it.
      const keepNotSent = state.notSent !== null && isShowing({ ...state, route: action.route }, state.notSent);
      return {
        ...state,
        route: action.route,
        conversation: conversationFor(action.route, state.conversation),
        notSent: keepNotSent ? state.notSent : null,
        tail: null,
        announcement: null, // an announcement belongs to the screen it was made on
      };
    }

    case "list_loading":
      // Keep the rows on screen during a refetch; only the first load shows skeletons.
      return { ...state, list: { ...state.list, status: state.list.status === "ready" ? "ready" : "loading" } };
    case "list_loaded":
      return { ...state, list: { status: "ready", items: action.items, warning: action.warning } };
    case "list_failed":
      // A failed refetch keeps the last good rows; only a list that never loaded shows the error.
      return state.list.status === "ready" ? state : { ...state, list: { ...state.list, status: "error" } };

    // Every conversation response is applied only if that conversation is still the open one.
    case "conversation_loading":
      if (openId(state.route) !== action.id) return state;
      // Reloading the conversation already on screen keeps it there. Otherwise a new chat's first
      // reply (shown at once by turn_completed) would flash a spinner and mount, and animate, twice.
      if (state.conversation.status === "ready" && state.conversation.view.id === action.id) return state;
      return { ...state, conversation: { status: "loading", id: action.id } };
    case "conversation_loaded":
      if (openId(state.route) !== action.view.id) return state;
      return { ...state, conversation: { status: "ready", view: action.view } };
    case "conversation_failed":
      if (openId(state.route) !== action.id) return state;
      // A failed background refresh keeps the transcript on screen.
      if (state.conversation.status === "ready") return state;
      return { ...state, conversation: { status: "error", id: action.id } };
    case "conversation_not_found":
      if (openId(state.route) !== action.id) return state;
      return { ...state, route: { view: "home" }, conversation: { status: "none" }, tail: null, toast: nextToast(state, NOT_FOUND_TOAST) };

    case "send_started":
      if (state.inflight !== null) return state; // one at a time, app-wide
      return { ...state, inflight: { ...action.sent, stage: "idle" }, notSent: null };
    case "stage": {
      if (state.inflight?.messageId !== action.messageId) return state;
      // A preview is kept once seen: a later poll without one must not take the cards away.
      const preview = action.preview ?? state.inflight.preview ?? null;
      if (state.inflight.stage === action.stage && preview === (state.inflight.preview ?? null)) return state;
      return { ...state, inflight: { ...state.inflight, stage: action.stage, preview } };
    }

    case "turn_completed": {
      // Only this message's tail is answered now. A reply landing for another chat must not erase the
      // open chat's "No reply yet." note, or that chat would show neither Retry nor a resume.
      const tail = state.tail?.messageId === action.sent.messageId ? null : state.tail;
      const next = { ...state, inflight: clearIf(state.inflight, action.sent), tail };
      const { response } = action;
      const announced = {
        announcement: { id: response.assistantMessage.id, text: describeReply(response.assistantMessage) },
      };
      if (openId(state.route) !== response.conversationId) {
        // A new chat whose reply lands while the user is still on home opens it (send.ts navigates).
        if (action.sent.conversationId === null && state.route.view === "home") {
          return {
            ...next,
            ...announced,
            route: { view: "conversation", id: response.conversationId },
            conversation: {
              status: "ready",
              view: {
                id: response.conversationId,
                // Provisional: the server's rule (trimmed first message, 60 chars). The next load replaces it.
                title: response.userMessage.text.trim().slice(0, 60),
                revision: response.revision,
                messages: [response.userMessage, response.assistantMessage],
              },
            },
          };
        }
        return next; // the user moved on; the reply is on the server and shows when they return
      }
      if (state.conversation.status !== "ready") return next; // a load is in flight and will bring it
      const view = state.conversation.view;
      return {
        ...next,
        ...announced,
        conversation: {
          status: "ready",
          view: {
            ...view,
            revision: Math.max(view.revision, response.revision),
            messages: mergeMessages(view.messages, [response.userMessage, response.assistantMessage]),
          },
        },
      };
    }

    case "conflict": {
      const next = { ...state, inflight: clearIf(state.inflight, action.sent) };
      if (openId(state.route) !== action.conversation.id) return next;
      return { ...next, conversation: { status: "ready", view: action.conversation } };
    }

    case "send_failed":
      return { ...state, inflight: clearIf(state.inflight, action.sent) };

    case "not_sent":
      return { ...state, inflight: clearIf(state.inflight, action.sent), notSent: action.sent };

    case "tail_checking":
      return { ...state, tail: { messageId: action.messageId, status: "checking" } };
    case "tail_stalled":
      if (state.tail?.messageId !== action.messageId) return state;
      return { ...state, tail: { messageId: action.messageId, status: "stalled" } };

    case "draft_restored":
      return { ...state, draftVersion: state.draftVersion + 1 };
    case "toast":
      return { ...state, toast: nextToast(state, action.message) };
    case "toast_dismissed":
      return state.toast === null ? state : { ...state, toast: null };
  }
}

const nextToast = (state: State, text: string) => ({ id: (state.toast?.id ?? 0) + 1, text });

function clearIf<T extends Sent>(inflight: T | null, sent: Sent): T | null {
  return inflight?.messageId === sent.messageId ? null : inflight;
}

/** The unanswered last user message of a view, if any. */
export function unansweredTail(view: ConversationView) {
  const last = view.messages.at(-1);
  return last?.role === "user" ? last : null;
}
