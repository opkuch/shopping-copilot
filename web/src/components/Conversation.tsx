import { t } from "../strings.ts";
import { useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { AssistantMessage as Assistant, Message, Preview, ProductCard as Card, Stage } from "../api/types.ts";
import type { ConversationState, Sent, TailState } from "../state/reducer.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { AssistantMessage, MessageFailed, UserMessage } from "./Messages.tsx";
import { RetryNote } from "./Pending.tsx";

const NEAR_BOTTOM_PX = 120;
/** Room above a reply scrolled to its top, so the edge of the question above it stays in view. */
const REPLY_GAP_PX = 24;

export type TurnProps = {
  /** The send in flight, only when it belongs to this transcript. */
  inflight: (Sent & { stage: Stage; preview?: Preview | null }) | null;
  /** A send that failed on the network, only when it belongs to this transcript. */
  notSent: Sent | null;
  tail: TailState | null;
  /** False while any send is in flight (one at a time, app-wide). */
  canRetry: boolean;
  onRetry(sent: Sent): void;
  /** Sends a suggestion chip's text as the user's next message. */
  onSuggest(text: string): void;
  /** A click on a card: asks about that product, by id. */
  onOpenCard(productId: number, text: string): void;
};

type Props = TurnProps & {
  messages: Message[];
  conversationId: string | null;
  revision: number;
  /** The conversation's title, as the page heading (visually hidden on phones, where the top bar shows it). */
  title?: string | null;
};

export function Transcript({ messages, conversationId, revision, inflight, notSent, tail, canRetry, onRetry, onSuggest, onOpenCard, title = null }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  // The first layout of a conversation jumps straight to its end; new content after that glides into view.
  const placed = useRef(false);

  const last = messages.at(-1);
  const tailMessage = last?.role === "user" ? last : null;
  const inMessages = (id: string) => messages.some((m) => m.id === id);
  const localInflight = inflight && !inMessages(inflight.messageId) ? inflight : null;
  const localNotSent = notSent && !inMessages(notSent.messageId) ? notSent : null;

  // Follow new content only when the reader was already at the bottom. When the newest thing is a
  // reply (or the early cards of one), stop at its top instead: a reply with cards is taller than the
  // screen, and scrolling to its bottom would push its own sentence out of view. The finished reply
  // has the same top as its early cards, so it does not scroll again.
  const hasPreview = (inflight?.preview?.groups.length ?? 0) > 0;
  const signature = `${messages.length}|${inflight?.messageId ?? ""}|${hasPreview}|${notSent?.messageId ?? ""}|${tail?.status ?? ""}`;
  const sending = localInflight !== null;
  const endsWithReply = (last?.role === "assistant" && !sending && localNotSent === null) || (sending && hasPreview);
  useLayoutEffect(() => {
    const el = log.current;
    // The user's own new message always scrolls into view, even after they scrolled up to read.
    if (!el || (!nearBottom.current && !sending)) return;
    let target = el.scrollHeight - el.clientHeight;
    const reply = endsWithReply ? el.querySelector<HTMLElement>(".messages > :last-child") : null;
    if (reply) {
      const top = reply.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - REPLY_GAP_PX;
      target = Math.min(target, top);
    }
    const glide = placed.current && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    placed.current = true;
    if (glide && typeof el.scrollTo === "function") el.scrollTo({ top: target, behavior: "smooth" });
    else el.scrollTop = target;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [signature, sending, endsWithReply]);

  const onScroll = () => {
    const el = log.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  function tailExtras(m: Message) {
    if (m !== tailMessage) return null;
    if (inflight?.messageId === m.id) return null; // the pending reply renders after the log
    if (tail?.messageId === m.id && tail.status === "stalled" && conversationId !== null) {
      return (
        <RetryNote
          text={t.noReplyYet}
          disabled={!canRetry}
          onRetry={() => onRetry({ messageId: m.id, text: m.text, conversationId, revision })}
        />
      );
    }
    return null;
  }

  // The reply whose cards "the second one" refers to: the latest one with results, as the server reads it.
  // An unreadable reply ends the search there, as it does on the server. This runs outside the per-message
  // error boundary, so a malformed message must not throw here.
  const latestSearch = messages.findLast((m) => m.role === "assistant" && (m.unreadable === true || (m.groups?.length ?? 0) > 0));
  const working = latestSearch?.role === "assistant" && !latestSearch.unreadable ? latestSearch : null;
  // Any card on screen can be opened, not only the latest search's: the click names the product by id.
  const openCard = (card: Card) => onOpenCard(card.id, t.tellMeAbout(card.title));

  const pendingStage = inflight && (localInflight !== null || inflight.messageId === tailMessage?.id) ? inflight.stage : null;

  // One keyed list, so React keeps each element across the moment a reply finishes: the in-flight user
  // bubble becomes the stored one (same id), and the reply on its way becomes the finished reply (both keyed
  // by the user message they answer). Cards already on screen are not remounted or animated twice.
  const items: ReactElement[] = messages.map((m, i) =>
    m.role === "user" ? (
      <div key={m.id} className="turn">
        <UserMessage message={m} />
        {tailExtras(m)}
      </div>
    ) : (
      <ErrorBoundary key={`reply:${messages[i - 1]?.id ?? m.id}`} fallback={<MessageFailed />}>
        {/* Chips answer the latest reply only; under an older one they would answer a stale question. */}
        <AssistantMessage
          message={m}
          onSuggest={m === messages.at(-1) && canRetry ? onSuggest : null}
          working={m === working}
          onOpen={canRetry ? openCard : null}
        />
      </ErrorBoundary>
    ),
  );
  if (localInflight) {
    items.push(
      // "sending": the bubble eases in once; the stored message takes over this element (same key) without replaying it.
      <div key={localInflight.messageId} className="turn sending">
        <UserMessage message={{ id: localInflight.messageId, text: localInflight.text }} />
      </div>,
    );
  }
  if (localNotSent) {
    items.push(
      <div key={localNotSent.messageId} className="turn">
        <UserMessage message={{ id: localNotSent.messageId, text: localNotSent.text }} />
        <RetryNote text={t.notSent} disabled={!canRetry} onRetry={() => onRetry(localNotSent)} />
      </div>,
    );
  }
  if (pendingStage !== null && inflight !== null) {
    const preview = inflight.preview ?? null;
    const onTheWay: Assistant = {
      id: `pending:${inflight.messageId}`, role: "assistant", text: preview?.text ?? "", groups: preview?.groups ?? [],
      detail: null, suggestions: [], unreadable: false, createdAt: "",
    };
    items.push(
      <ErrorBoundary key={`reply:${inflight.messageId}`} fallback={<MessageFailed />}>
        {/* Numbered already when the early cards will be the working search, so numbers don't pop in later. */}
        <AssistantMessage message={onTheWay} pending={pendingStage} working={hasPreview} />
      </ErrorBoundary>,
    );
  }

  // role="log" names the transcript for navigation, but it is not live (aria-live="off"): new replies
  // are announced once, as a summary, by the app-level Announcer. A live log would read every card
  // aloud, and would stay silent for a new chat's first reply (which mounts with the log itself).
  // The pending reply has its own role="status" for the stage label.
  return (
    // Focusable so the conversation can be scrolled from the keyboard (axe: scrollable-region-focusable).
    <div className="transcript" ref={log} onScroll={onScroll} tabIndex={0}>
      <div className="messages-column">
      {title && (
        <h1 className="conversation-title">
          {title}
        </h1>
      )}
      <div className="messages" role="log" aria-live="off" aria-label={t.conversation}>
        {items}
      </div>
      </div>
    </div>
  );
}

/** A chat that has no id yet: home, while its first message is on its way. */
export const NEW_CHAT_VIEW: ConversationState = { status: "ready", view: { id: "", title: "", revision: 0, messages: [] } };

export function ConversationPane({ conversation, onRetryLoad, turn }: { conversation: ConversationState; onRetryLoad(): void; turn: TurnProps }) {
  switch (conversation.status) {
    case "none":
      return null;
    case "loading":
      return (
        <div className="pane-center" aria-busy="true">
          <span className="spinner" />
          <span className="visually-hidden">{t.loadingConversation}</span>
        </div>
      );
    case "error":
      return (
        <div className="pane-center">
          <p>{t.conversationFailed}</p>
          <button type="button" className="button" onClick={onRetryLoad}>
            {t.retry}
          </button>
        </div>
      );
    case "ready": {
      const { view } = conversation;
      // Keyed by the chat's first message: another chat starts fresh, and a new chat keeps its transcript
      // (and the reply on its way) when it gets its id.
      const firstMessage = view.messages[0]?.id ?? turn.inflight?.messageId ?? turn.notSent?.messageId ?? view.id;
      return (
        <Transcript
          key={firstMessage}
          messages={view.messages}
          conversationId={view.id === "" ? null : view.id}
          revision={view.revision}
          title={view.title}
          {...turn}
        />
      );
    }
  }
}
