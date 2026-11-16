import { useT } from "../i18n.ts";
import type { Stage } from "../api/types.ts";

/**
 * The progress line at the foot of a reply on its way: the polled server stage. It sits where the
 * chips will be, so the finished reply swaps one row for the other instead of growing.
 */
export function PendingRow({ stage }: { stage: Stage }) {
  const t = useT();
  return (
    <div className="pending-row">
      <span className="dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span role="status" className="pending-label">
        {t.stage[stage]}
      </span>
    </div>
  );
}

/** A user bubble with a problem under it and a Retry button. */
export function RetryNote({ text, onRetry, disabled }: { text: string; onRetry(): void; disabled: boolean }) {
  return (
    <div className="retry-note">
      <span>{text}</span>
      <button type="button" className="button small" onClick={onRetry} disabled={disabled}>
        {useT().retry}
      </button>
    </div>
  );
}
