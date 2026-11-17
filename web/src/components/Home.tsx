import { t } from "../strings.ts";
// The app name is already in the sidebar's tab title and the phone top bar, so the heading asks the
// question instead of repeating the name.
export function Home({ canSend, onSend }: { canSend: boolean; onSend(text: string): void }) {
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
