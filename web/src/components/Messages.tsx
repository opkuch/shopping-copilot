import { t } from "../strings.ts";
import { useState } from "react";
import type { AssistantMessage as Assistant, ProductCard as Card, Stage, UserMessage as User } from "../api/types.ts";
import { PendingRow } from "./Pending.tsx";
import { ProductDetail } from "./ProductDetail.tsx";
import { ProductGroup } from "./ProductGroup.tsx";

export function UserMessage({ message }: { message: Pick<User, "id" | "text"> }) {
  return (
    <div className="message user">
      <p className="bubble">
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
  /** This reply holds the search the chat is working on: its cards are numbered ("the second one" means them). */
  working?: boolean;
  onOpen?: ((card: Card) => void) | null;
  /**
   * Set while the reply is on its way: `message` holds the early cards and the template sentence (muted),
   * and a progress row stands where the chips will be. The finished reply renders into this same element
   * (Transcript keys both by the user message), so the cards stay put and only the sentence and the
   * bottom row change.
   */
  pending?: Stage | null;
};

export function AssistantMessage({ message, onSuggest = null, working = false, onOpen = null, pending = null }: AssistantProps) {
  // Decided once, on mount: a re-render (or the finished reply replacing the preview) must not restart it.
  const [fresh] = useState(() => pending !== null || isFresh(message.createdAt));
  return (
    <div className={`message assistant${fresh ? " fresh" : ""}${pending ? " pending" : ""}`}>
      {message.text !== "" && (
        // Keyed by the text: when the written reply replaces the template sentence, the new one fades in
        // instead of the words changing under the reader.
        <p key={message.text} className={pending ? "assistant-text draft" : "assistant-text"}>
          {message.text}
        </p>
      )}
      {message.unreadable ? (
        <p className="group-note warning" role="note">
          {t.resultsUnreadable}
        </p>
      ) : (
        <>
          {message.groups.map((g, i) =>
            // A change to one item of a list carries the others forward unchanged ("repeat"): their cards are in
            // the message above, so only the changed groups are drawn. A lone kept group still says so in a line.
            g.repeat && message.groups.length > 1 ? null : (
              <ProductGroup
                key={`${i}-${g.label}`}
                group={g}
                // Numbers run across every group, hidden ones included, as the server counts "the third one".
                firstPosition={working ? 1 + message.groups.slice(0, i).reduce((n, x) => n + x.products.length, 0) : null}
                onOpen={onOpen}
              />
            ))}
          {message.detail && <ProductDetail detail={message.detail} />}
        </>
      )}
      {pending && <PendingRow stage={pending} />}
      {!pending && onSuggest !== null && message.suggestions.length > 0 && (
        <ul className="suggestions" aria-label={t.suggested}>
          {message.suggestions.map((s) => (
            <li key={s.text}>
              <button type="button" className="starter" onClick={() => onSuggest(s.text)}>
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
        {t.messageFailed}
      </p>
    </div>
  );
}
