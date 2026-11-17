import { t } from "../strings.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { MAX_TEXT } from "../api/types.ts";
import { getDraft, setDraft } from "../state/drafts.ts";

const COUNTER_FROM = 1800;
const MAX_LINES = 6;

/** Grow with the text up to MAX_LINES, then scroll. */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const style = getComputedStyle(el);
  const line = parseFloat(style.lineHeight) || 20;
  const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2; // padding + border
  el.style.height = `${Math.min(el.scrollHeight + 2, line * MAX_LINES + chrome)}px`;
}

type Props = {
  /** Conversation id, or "new" on home. The parent keys the composer by it, so each has its own draft. */
  draftKey: string;
  /** False while any send is in flight (one at a time, app-wide). */
  canSend: boolean;
  /** Focus on mount, for devices with a fine pointer only (no on-screen keyboard popping open). */
  autoFocus?: boolean;
  onSend(text: string): void;
};

export function Composer({ draftKey, canSend, autoFocus = false, onSend }: Props) {
  const [text, setText] = useState(() => getDraft(draftKey));
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) area.current?.focus();
  }, [autoFocus]);

  // Grow with the text up to MAX_LINES, then scroll. `text` is the trigger, not an input: the effect
  // measures the DOM after React has written the new value into it.
  useLayoutEffect(() => {
    if (area.current) fitHeight(area.current);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [text]);

  // The first measurement can happen before the layout settles, and a window resize rewraps the
  // text, so re-measure whenever the width changes (height changes are our own and are ignored).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const trimmed = text.trim();
  const tooLong = text.length > MAX_TEXT;
  const sendable = canSend && trimmed.length > 0 && !tooLong;

  function update(next: string) {
    setText(next);
    setDraft(draftKey, next);
  }

  // No extra double-submit guard is needed: React flushes a discrete event (keydown, click) before the
  // next one is handled, so a second Enter already sees the cleared text and canSend = false.
  function submit() {
    if (!sendable) return;
    onSend(trimmed);
    update("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      <label htmlFor="composer-input" className="visually-hidden">
        {t.message}
      </label>
      <textarea
        id="composer-input"
        ref={area}
       
        rows={1}
        value={text}
        placeholder={t.placeholder}
        aria-invalid={tooLong || undefined}
        aria-describedby={text.length > COUNTER_FROM ? "composer-counter" : undefined}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {text.length > COUNTER_FROM && (
        <span id="composer-counter" className={tooLong ? "composer-counter over" : "composer-counter"}>
          {text.length} / {MAX_TEXT}
        </span>
      )}
      <button type="submit" className="button primary" disabled={!sendable}>
        {t.send}
      </button>
    </form>
  );
}
