import { useT } from "../i18n.ts";
import { useState } from "react";
import type { AssistantMessage as Assistant, Stage, UserMessage as User } from "../api/types.ts";
import { PendingRow } from "./Pending.tsx";
import { ProductDetail } from "./ProductDetail.tsx";
import { ProductGroup } from "./ProductGroup.tsx";

export function UserMessage({ message }: { message: Pick<User, "id" | "text"> }) {
  return (
    <div className="message user">
      <p className="bubble" dir="auto">
        {message.text}
      </p>
    </div>
  );
}

// A reply younger than this when it first renders just arrived, so its cards animate in. Opening a
// conversation from the list renders older replies, which never animate.
const FRESH_MS = 15_000;

const isFresh = (createdAt: string) => Date.now() - Date.parse(createdAt) < FRESH_MS;

/** Text first, then the widgets. Text is plain: React escapes it, nothing is parsed as HTML. */
type AssistantProps = {
  message: Assistant;
  onSuggest?: ((text: string) => void) | null;
  animate?: boolean;
  /** This reply holds the search the chat is working on: its cards are numbered and open on click. */
  working?: boolean;
  onOpen?: ((title: string) => void) | null;
  /**
   * Set while the reply is on its way: `message` holds the early cards and the template sentence (muted),
   * and a progress row stands where the chips will be. The finished reply renders into this same element
   * (Transcript keys both by the user message), so the cards stay put and only the sentence and the
   * bottom row change.
   */
  pending?: Stage | null;
};

export function AssistantMessage({ message, onSuggest = null, animate = true, working = false, onOpen = null, pending = null }: AssistantProps) {
  // Decided once, on mount: a re-render (or the finished reply replacing the preview) must not restart it.
  const [fresh] = useState(() => animate && (pending !== null || isFresh(message.createdAt)));
  const t = useT();
  return (
    <div className={`message assistant${fresh ? " fresh" : ""}${pending ? " pending" : ""}`}>
      {message.text !== "" && (
        <p className={pending ? "assistant-text draft" : "assistant-text"} dir="auto">
          {message.text}
        </p>
      )}
      {message.unreadable ? (
        <p className="group-note warning" role="note">
          {t.resultsUnreadable}
        </p>
      ) : (
        <>
          {message.groups.map((g, i) => (
            // Removing a filter refines the search, so only the latest reply with a single search offers it.
            // Numbers run across both groups, as the server counts "the third one".
            <ProductGroup
              key={`${i}-${g.label}`}
              group={g}
              onRefine={message.groups.length === 1 ? onSuggest : null}
              firstPosition={working ? 1 + message.groups.slice(0, i).reduce((n, x) => n + x.products.length, 0) : null}
              onOpen={working ? onOpen : null}
            />
          ))}
          {message.detail && <ProductDetail detail={message.detail} />}
        </>
      )}
      {pending && <PendingRow stage={pending} />}
      {/* A message saved before chips existed has none. */}
      {!pending && onSuggest !== null && (message.suggestions ?? []).length > 0 && (
        <ul className="suggestions" aria-label={t.suggested}>
          {message.suggestions.map((s) => (
            <li key={s.text}>
              <button type="button" className="starter" dir="auto" onClick={() => onSuggest(s.text)}>
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MessageFailed() {
  return (
    <div className="message assistant">
      <p className="group-note warning" role="note">
        {useT().messageFailed}
      </p>
    </div>
  );
}
