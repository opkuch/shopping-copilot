import { useT } from "../i18n.ts";
import type { LangPref } from "../i18n.ts";
import { useEffect, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { formatRelative } from "../format.ts";
import { Brand } from "./Brand.tsx";
import type { ListState } from "../state/reducer.ts";
import { pathFor } from "../state/router.ts";
import type { Route } from "../state/router.ts";

type Props = {
  langPref: LangPref;
  onLangPref(pref: LangPref): void;
  list: ListState;
  activeId: string | null;
  onNavigate(route: Route): void;
  onRetry(): void;
  /** The drawer below 900 px; ignored on wide screens. */
  drawer?: { ref: RefObject<HTMLElement | null>; open: boolean; hidden: boolean };
};

/** Re-renders relative times once a minute. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// Real links, so middle-click and "open in new tab" work; a plain click stays in the app.
function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function Sidebar({ list, activeId, onNavigate, onRetry, drawer, langPref, onLangPref }: Props) {
  const t = useT();
  const now = useNow();
  const go = (route: Route) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    onNavigate(route);
  };

  return (
    <nav
      id="sidebar"
      ref={drawer?.ref}
      className={drawer?.open ? "sidebar open" : "sidebar"}
      aria-label={t.conversations}
      // Off-screen drawer: not focusable and not read until opened.
      inert={drawer?.hidden || undefined}
    >
      <Brand name={t.appName} />
      <label className="lang-picker">
        <span>{t.language}</span>
        <select value={langPref} onChange={(e) => onLangPref(e.target.value as LangPref)}>
          <option value="auto">{t.langAuto}</option>
          <option value="en">English</option>
          <option value="he">עברית</option>
        </select>
      </label>
      <a className="button primary new-chat" href="/" onClick={go({ view: "home" })}>
        {t.newChat}
      </a>

      {list.warning === "previous_history_unreadable" && (
        <p className="banner" role="note">
          {t.historyUnreadable}
        </p>
      )}

      {list.status === "loading" && (
        <ul className="conversation-list" aria-busy="true" aria-label={t.loadingConversations}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}

      {list.status === "error" && (
        <div className="list-error">
          <p>{t.listFailed}</p>
          <button type="button" className="button" onClick={onRetry}>
            {t.retry}
          </button>
        </div>
      )}

      {list.status === "ready" && list.items.length === 0 && <p className="muted list-empty">{t.noConversations}</p>}

      {list.status === "ready" && list.items.length > 0 && (
        <ul className="conversation-list">
          {list.items.map((c) => {
            const route: Route = { view: "conversation", id: c.id };
            const active = c.id === activeId;
            return (
              <li key={c.id}>
                <a
                  href={pathFor(route)}
                  className={active ? "conversation-link active" : "conversation-link"}
                  aria-current={active ? "page" : undefined}
                  onClick={go(route)}
                >
                  <span className="conversation-title" dir="auto">
                    {c.title}
                  </span>
                  <time className="conversation-time" dateTime={c.updatedAt}>
                    {formatRelative(c.updatedAt, now)}
                  </time>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
