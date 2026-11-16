import { useT } from "../i18n.ts";
import { useEffect, useState } from "react";

const SHOW_MS = 6000;

type ToastMessage = { id: number; text: string };

export function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss(): void }) {
  // Keyed on the id, not the text: the same message twice restarts the timer.
  const id = toast?.id ?? null;
  const t = useT();
  // Paused while the pointer or focus is on it, so a slow reader is not cut off; the timer restarts on leave.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (id === null || paused) return;
    const timer = setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss, paused]);

  // The region is always mounted so screen readers register it before the first message. The keyed
  // child is a new node per toast, so a repeated message is announced again.
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast !== null && (
        <div
          className="toast"
          key={toast.id}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <span>{t.toasts[toast.text] ?? toast.text}</span>
          <button type="button" className="toast-close" aria-label={t.dismiss} onClick={onDismiss}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
