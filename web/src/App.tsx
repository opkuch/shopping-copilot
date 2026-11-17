import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { api as defaultClient } from "./api/client.ts";
import type { ApiClient } from "./api/client.ts";
import { Composer } from "./components/Composer.tsx";
import { ConversationPane, NEW_CHAT_VIEW } from "./components/Conversation.tsx";
import type { TurnProps } from "./components/Conversation.tsx";
import { Announcer } from "./components/Announcer.tsx";
import { Brand } from "./components/Brand.tsx";
import { Home } from "./components/Home.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { NARROW_QUERY, useDrawer, useMediaQuery } from "./state/drawer.ts";
import { Toast } from "./components/Toast.tsx";
import { NEW_CHAT } from "./state/drafts.ts";
import { useConversation, useConversationList, useProgress, useTailResume } from "./state/effects.ts";
import { initialState, isShowing, reducer, unansweredTail } from "./state/reducer.ts";
import type { Sent } from "./state/reducer.ts";
import { currentRoute, navigate, onPopState } from "./state/router.ts";
import type { Route } from "./state/router.ts";
import { useSend } from "./state/send.ts";
import { t } from "./strings.ts";

const APP_TITLE = "Shopping copilot";

export function App({ client = defaultClient }: { client?: ApiClient }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(currentRoute()));
  const { route, list, conversation, inflight, notSent, tail, toast } = state;
  const activeId = route.view === "conversation" ? route.id : null;

  // Event handlers and the resume effect read the latest state through this ref, not a stale closure.
  // Updated in a layout effect: after the commit, before any passive effect or event handler runs.
  const stateRef = useRef(state);
  const paused = useRef(false);
  useLayoutEffect(() => {
    stateRef.current = state;
    paused.current = state.inflight !== null;
  });

  useEffect(() => onPopState((r) => dispatch({ type: "route_changed", route: r })), []);
  const reloadList = useConversationList(client, dispatch);
  const reloadConversation = useConversation(client, dispatch, activeId, paused);
  const send = useSend(client, dispatch, stateRef, reloadList);
  useProgress(client, dispatch, inflight?.messageId ?? null);

  const view = conversation.status === "ready" ? conversation.view : null;
  const tailMessage = view ? unansweredTail(view) : null;
  useTailResume(client, dispatch, stateRef, send, tailMessage?.id ?? null, inflight?.messageId === tailMessage?.id);

  const narrow = useMediaQuery(NARROW_QUERY);
  const { isOpen: drawerOpen, close: closeDrawer, toggle: toggleDrawer, drawerRef, buttonRef } = useDrawer(narrow);

  const go = useCallback(
    (r: Route) => {
      navigate(r);
      dispatch({ type: "route_changed", route: r });
      closeDrawer();
    },
    [closeDrawer],
  );
  const dismissToast = useCallback(() => dispatch({ type: "toast_dismissed" }), []);

  const activeTitle = view ? view.title : (list.items.find((c) => c.id === activeId)?.title ?? null);
  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} · ${APP_TITLE}` : APP_TITLE;
  }, [activeTitle]);

  const onSend = useCallback(
    (text: string, productId?: number) => {
      const s = stateRef.current;
      const open = s.conversation.status === "ready" ? s.conversation.view : null;
      if (s.route.view === "conversation" && !open) return;
      void send({
        messageId: crypto.randomUUID(),
        text,
        conversationId: open ? open.id : null,
        revision: open ? open.revision : 0,
        ...(productId !== undefined ? { productId } : {}),
      });
    },
    [send],
  );
  const onRetry = useCallback((sent: Sent) => void send(sent), [send]);

  const shownInflight = inflight && isShowing(state, inflight) ? inflight : null;
  const shownNotSent = notSent && isShowing(state, notSent) ? notSent : null;
  const turn: TurnProps = {
    inflight: shownInflight,
    notSent: shownNotSent,
    tail,
    canRetry: inflight === null,
    onRetry,
    onSuggest: onSend,
    onOpenCard: (productId, text) => onSend(text, productId),
  };
  const homeHasTurn = route.view === "home" && (shownInflight !== null || shownNotSent !== null);
  const canSend = inflight === null && (route.view === "home" || view !== null);
  const draftKey = activeId ?? NEW_CHAT;

  return (
    <div className="app">
      <header className="topbar" inert={drawerOpen || undefined}>
        <button
          ref={buttonRef}
          type="button"
          className="menu-button"
          aria-label={t.conversations}
          aria-expanded={drawerOpen}
          aria-controls="sidebar"
          onClick={toggleDrawer}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {activeTitle ? (
          <span className="topbar-title">
            {activeTitle}
          </span>
        ) : (
          <Brand name={APP_TITLE} />
        )}
      </header>
      <Sidebar
        list={list}
        activeId={activeId}
        onNavigate={go}
        onRetry={reloadList}
        drawer={{ ref: drawerRef, open: drawerOpen, hidden: narrow && !drawerOpen }}
      />
      {drawerOpen && <div className="scrim" aria-hidden="true" onClick={closeDrawer} />}
      <main className="main" inert={drawerOpen || undefined}>
        {route.view === "home" && !homeHasTurn ? (
          <Home canSend={canSend} onSend={onSend} />
        ) : (
          // A new chat's first send renders in the same pane as the chat it becomes, so its reply is not
          // remounted when the address changes to /c/{id}.
          <ConversationPane conversation={route.view === "home" ? NEW_CHAT_VIEW : conversation} onRetryLoad={reloadConversation} turn={turn} />
        )}
        <Composer
          key={`${draftKey}:${state.draftVersion}`}
          draftKey={draftKey}
          canSend={canSend}
          autoFocus
          onSend={onSend}
        />
      </main>
      <Toast toast={toast} onDismiss={dismissToast} />
      <Announcer announcement={state.announcement} />
    </div>
  );
}
