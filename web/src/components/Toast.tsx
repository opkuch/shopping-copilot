import { t } from "../strings.ts";
import { useEffect, useState } from "react";

const SHOW_MS = 6000;

type ToastMessage = { id: number; text: string };

export function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss(): void }) {
  // The region is always mounted so screen readers register it before the first message. The item is
  // keyed on the id, not the text: a new node per toast, so a repeated message is announced again and
  // its timer starts over.
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast !== null && <ToastItem key={toast.id} text={toast.text} onDismiss={onDismiss} />}
    </div>
  );
}

function ToastItem({ text, onDismiss }: { text: string; onDismiss(): void }) {
  // Paused while the pointer or focus is on it, so a slow reader is not cut off; the timer restarts on leave.
  // The state lives here, per toast: one dismissed while hovered (no leave or blur ever fires) can't leave
  // the next toast paused for good.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(timer);
  }, [onDismiss, paused]);

  return (
    <div
      className="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span>{text}</span>
      <button type="button" className="toast-close" aria-label={t.dismiss} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
