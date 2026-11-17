// Effects only load, poll, and resume. Each one aborts its requests in
// cleanup, so React StrictMode's double run in development cancels the first run instead of doubling it.
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject } from "react";
import type { ApiClient } from "../api/client.ts";
import type { Action, Sent, State } from "./reducer.ts";
import { navigate } from "./router.ts";

/**
 * Loads the open conversation whenever the id changes, and quietly again when the tab becomes visible.
 * A new id aborts the previous request, so a slow answer for A can never land on B's screen
 * (the reducer checks the id as well). Returns a reload for the error state's Retry button.
 */
export function useConversation(
  client: ApiClient,
  dispatch: Dispatch<Action>,
  id: string | null,
  /** True while a send is in flight: a background reload then would race the reply. */
  paused: RefObject<boolean>,
): () => void {
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    (quiet: boolean) => {
      controller.current?.abort();
      if (id === null) return;
      const c = new AbortController();
      controller.current = c;
      if (!quiet) dispatch({ type: "conversation_loading", id });
      void client.getConversation(id, c.signal).then((res) => {
        if (res.ok) return dispatch({ type: "conversation_loaded", view: res.data });
        if (res.kind === "aborted") return;
        if (res.kind === "not_found") {
          // Replace, so Back does not return to a conversation that is gone.
          navigate({ view: "home" }, { replace: true });
          return dispatch({ type: "conversation_not_found", id });
        }
        dispatch({ type: "conversation_failed", id });
      });
    },
    [client, dispatch, id],
  );

  useEffect(() => {
    load(false);
    const onVisible = () => {
      if (document.visibilityState === "visible" && !paused.current) load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      controller.current?.abort();
    };
  }, [load, paused]);

  return useCallback(() => load(false), [load]);
}

// Short enough that the cards appear soon after retrieval (cards first), long enough to stay one request at a time.
export const POLL_MS = 400;

/**
 * Polls the stage of the send in flight, for the progress label. A failed poll is ignored.
 * The next poll is scheduled only after the previous one answers, so a slow server never has more
 * than one poll waiting, and a hidden tab skips the request (nobody is looking at the label).
 */
export function useProgress(client: ApiClient, dispatch: Dispatch<Action>, messageId: string | null): void {
  useEffect(() => {
    if (messageId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    const tick = () => {
      if (document.visibilityState === "hidden") return schedule();
      void client.getProgress(messageId, controller.signal).then((res) => {
        if (res.ok) {
          dispatch({ type: "stage", messageId, stage: res.data.stage, preview: res.data.preview ?? null });
        }
        schedule();
      });
    };
    tick();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, dispatch, messageId]);
}

// Message ids this page has already resent automatically. Module-level, so a StrictMode double run
// or a re-render cannot resend twice. A second resend would still be harmless (the server joins the
// run in flight, and messages merge by id), but it would double the polling.
const resumed = new Set<string>();

/**
 * Unanswered tail: when the open conversation ends with a user message that no send in
 * this tab covers, ask the server once whether a run is in flight. If so, resend the same body and
 * the server joins that run (no second model call). If not, show "No reply yet." with Retry.
 */
export function useTailResume(
  client: ApiClient,
  dispatch: Dispatch<Action>,
  stateRef: RefObject<State>,
  send: (sent: Sent) => Promise<void>,
  tailId: string | null,
  covered: boolean,
): void {
  useEffect(() => {
    if (tailId === null || covered) return;
    if (stateRef.current.tail?.messageId === tailId && stateRef.current.tail.status === "stalled") return;
    const controller = new AbortController();
    dispatch({ type: "tail_checking", messageId: tailId });
    void client.getProgress(tailId, controller.signal).then((res) => {
      if (!res.ok) {
        if (res.kind !== "aborted") dispatch({ type: "tail_stalled", messageId: tailId });
        return;
      }
      const state = stateRef.current;
      const view = state.conversation.status === "ready" ? state.conversation.view : null;
      const tail = view?.messages.at(-1);
      // A send in flight elsewhere would make send() return without doing anything, leaving this tail
      // "checking" forever. Stalled shows Retry instead, which works once that send finishes.
      if (
        res.data.stage === "idle" || resumed.has(tailId) || state.inflight !== null ||
        !view || tail?.id !== tailId || tail.role !== "user"
      ) {
        dispatch({ type: "tail_stalled", messageId: tailId });
        return;
      }
      resumed.add(tailId);
      void send({ messageId: tailId, text: tail.text, conversationId: view.id, revision: view.revision });
    });
    return () => controller.abort();
  }, [client, dispatch, stateRef, send, tailId, covered]);
}

/** Loads the conversation list on mount and whenever the tab becomes visible again. */
export function useConversationList(client: ApiClient, dispatch: Dispatch<Action>): () => void {
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    dispatch({ type: "list_loading" });
    void client.listConversations(c.signal).then((res) => {
      if (res.ok) dispatch({ type: "list_loaded", items: res.data.conversations, warning: res.data.warning });
      else if (res.kind !== "aborted") dispatch({ type: "list_failed" });
    });
  }, [client, dispatch]);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      controller.current?.abort();
    };
  }, [load]);

  return load;
}
