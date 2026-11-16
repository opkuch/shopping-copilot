import { useT } from "../i18n.ts";
// Realistic requests the catalog can answer, each checked against the live model.
// "Running shoes under $100" was dropped: the catalog has no running shoes, so it returned nothing.
// The assignment's probes ("something cheap and cool", "a flight to Tokyo") live in the browser tests
// and the README: a product never suggests a request it cannot fulfill.
export const STARTER_PROMPTS = [
  "A dress under $50",
  "A smartphone with a good rating",
  "Something for my skin care routine",
];

// The app name is already in the sidebar's tab title and the phone top bar, so the heading asks the
// question instead of repeating the name.
export function Home({ canSend, onSend }: { canSend: boolean; onSend(text: string): void }) {
  const t = useT();
  return (
    <section className="home" aria-labelledby="home-title">
      <h1 id="home-title">{t.homeTitle}</h1>
      <p className="muted">{t.homeLead}</p>
      <ul className="starters" aria-label={t.tryAsking}>
        {t.starters.map((prompt) => (
          <li key={prompt}>
            <button type="button" className="starter" disabled={!canSend} onClick={() => onSend(prompt)}>
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
