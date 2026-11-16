/**
 * The one place new replies are announced to screen readers. It is always mounted, so a reply that
 * arrives together with a freshly mounted transcript (a new chat's first reply) is still heard, and
 * it reads a summary ("Dresses: 4 of 10 results") instead of every card.
 */
export function Announcer({ announcement }: { announcement: { id: string; text: string } | null }) {
  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement && <span key={announcement.id}>{announcement.text}</span>}
    </div>
  );
}
