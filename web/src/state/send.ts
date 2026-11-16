// Sending and retrying. Called from event handlers (composer, starter prompt, Retry) and from the
// unanswered-tail resume, never from a render. One send at a time, app-wide.
import { useCallback } from "react";
import type { Dispatch, RefObject } from "react";
import type { ApiClient } from "../api/client.ts";
import { getDraft, NEW_CHAT, setDraft } from "./drafts.ts";
import { planOutcome } from "./outcome.ts";
import type { Action, Sent, State } from "./reducer.ts";
import { hasMessage, isShowing } from "./reducer.ts";
import { navigate } from "./router.ts";

/** Puts text back without losing anything typed since the send. */
function restoreDraft(key: string, text: string): void {
  const current = getDraft(key);
  setDraft(key, current.trim() === "" ? text : `${text}\n${current}`);
}

export function useSend(
  client: ApiClient,
  dispatch: Dispatch<Action>,
  stateRef: RefObject<State>,
  reloadList: () => void,
): (sent: Sent) => Promise<void> {
  return useCallback(
    async (sent: Sent) => {
      if (stateRef.current.inflight !== null) return;
      dispatch({ type: "send_started", sent });

      const result =
        sent.conversationId === null
          ? await client.createConversation({ messageId: sent.messageId, text: sent.text })
          : await client.sendMessage(sent.conversationId, {
              messageId: sent.messageId,
              text: sent.text,
              revision: sent.revision,
            });

      const plan = planOutcome(sent, result, isShowing(stateRef.current, sent));
      if (plan.replaceRoute) navigate(plan.replaceRoute, { replace: true });
      for (const action of plan.actions) dispatch(action);
      if (plan.replaceRoute) dispatch({ type: "route_changed", route: plan.replaceRoute });

      const draftKey = !result.ok && result.kind === "not_found" ? NEW_CHAT : (sent.conversationId ?? NEW_CHAT);
      if (plan.restoreDraft) {
        restoreDraft(draftKey, sent.text);
        dispatch({ type: "draft_restored" });
      }

      if (plan.reloadConversation && sent.conversationId !== null) {
        const reloaded = await client.getConversation(sent.conversationId);
        if (reloaded.ok) {
          dispatch({ type: "conversation_loaded", view: reloaded.data });
          if (plan.restoreIfMissingAfterReload && !hasMessage(reloaded.data, sent.messageId)) {
            restoreDraft(draftKey, sent.text);
            dispatch({ type: "draft_restored" });
          }
        } else if (plan.restoreIfMissingAfterReload) {
          // We cannot tell whether it was stored; the text is safer back in the box than lost.
          restoreDraft(draftKey, sent.text);
          dispatch({ type: "draft_restored" });
        }
      }

      reloadList();
    },
    [client, dispatch, stateRef, reloadList],
  );
}
