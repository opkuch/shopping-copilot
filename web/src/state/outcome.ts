// What to do with the answer to a send. Pure, so every row of
// that table is a unit test. send.ts executes the plan (dispatch, history, drafts, reloads).
import type { Result } from "../api/client.ts";
import type { TurnResponse } from "../api/types.ts";
import type { Action, Sent } from "./reducer.ts";
import { hasMessage } from "./reducer.ts";
import type { Route } from "./router.ts";

export type OutcomePlan = {
  actions: Action[];
  /** Put the text back into this conversation's draft ("new" for a new chat). */
  restoreDraft: boolean;
  /** Replace the current history entry with this route, if the user is still where the send started. */
  replaceRoute: Route | null;
  /** Reload the open conversation (quietly) after applying the actions. */
  reloadConversation: boolean;
  /** For `internal`: reload, then restore the draft only if the transcript lacks the message. */
  restoreIfMissingAfterReload: boolean;
};

const plan = (over: Partial<OutcomePlan>): OutcomePlan => ({
  actions: [],
  restoreDraft: false,
  replaceRoute: null,
  reloadConversation: false,
  restoreIfMissingAfterReload: false,
  ...over,
});

export const CONFLICT_TOAST = "This chat changed in another tab. Your message wasn't sent.";
export const STORAGE_TOAST = "Your message couldn't be saved. Nothing was sent.";
export const INTERNAL_TOAST = "Something went wrong.";

/**
 * `showing` is whether the send's conversation is on screen right now (state.ts `isShowing`).
 * The one draft rule: the text goes back only if the server's transcript does not contain it.
 */
export function planOutcome(sent: Sent, result: Result<TurnResponse>, showing: boolean): OutcomePlan {
  if (result.ok) {
    const opened = sent.conversationId === null && showing;
    return plan({
      actions: [{ type: "turn_completed", sent, response: result.data }],
      replaceRoute: opened ? { view: "conversation", id: result.data.conversationId } : null,
    });
  }

  switch (result.kind) {
    case "conflict": {
      const stored = hasMessage(result.conversation, sent.messageId);
      const actions: Action[] = [{ type: "conflict", sent, conversation: result.conversation }];
      if (!stored) actions.push({ type: "toast", message: CONFLICT_TOAST });
      return plan({ actions, restoreDraft: !stored });
    }
    case "reply_failed":
      // The message is stored. The transcript shows it as the unanswered tail with Retry.
      if (sent.conversationId === null) {
        return plan({
          actions: [{ type: "send_failed", sent }],
          replaceRoute: showing ? { view: "conversation", id: result.conversationId } : null,
        });
      }
      return plan({ actions: [{ type: "send_failed", sent }], reloadConversation: showing });
    case "storage_failed":
      return plan({ actions: [{ type: "send_failed", sent }, { type: "toast", message: STORAGE_TOAST }], restoreDraft: true });
    case "internal":
      if (sent.conversationId === null) {
        return plan({ actions: [{ type: "send_failed", sent }, { type: "toast", message: INTERNAL_TOAST }], restoreDraft: true });
      }
      return plan({
        actions: [{ type: "send_failed", sent }, { type: "toast", message: INTERNAL_TOAST }],
        reloadConversation: showing,
        restoreIfMissingAfterReload: true,
      });
    case "validation":
      return plan({ actions: [{ type: "send_failed", sent }, { type: "toast", message: result.message }], restoreDraft: true });
    case "not_found": {
      const actions: Action[] = [{ type: "send_failed", sent }];
      if (sent.conversationId !== null) actions.push({ type: "conversation_not_found", id: sent.conversationId });
      return plan({ actions, restoreDraft: true, replaceRoute: showing ? { view: "home" } : null });
    }
    case "network":
    case "aborted":
      // The server may or may not have it. Keep the bubble with "Not sent." and Retry; resending is safe.
      return plan({ actions: [{ type: "not_sent", sent }] });
  }
}
