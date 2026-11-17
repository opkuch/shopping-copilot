// The per-turn context both models read after their fixed instructions: the exchange before this message,
// what the conversation is about, and what is on screen.
import type { ConversationMemory } from "../messages/schema.ts";
import type { RouterInput } from "../pipeline/ports.ts";

/** The memory as the models read it: one short line each, or null when there is nothing to remember. */
export function describeMemory(m: ConversationMemory | null): { purpose: string | null; rejected: string[] } | null {
  if (m === null || (m.purpose === null && m.excluded.length === 0)) return null;
  const p = m.purpose;
  const who = p === null ? null : p.kid ? "a child" : p.gender === "mens" ? "a man" : p.gender === "womens" ? "a woman" : null;
  const purpose = p?.gift ? `a gift${who ? ` for ${who}` : ""}` : null;
  return { purpose, rejected: m.excluded };
}

export function turnContext(input: RouterInput): string {
  return JSON.stringify({
    previousExchange: input.previous ?? null,
    conversation: describeMemory(input.memory ?? null),
    storedQueries: input.storedQueries,
    shownCards: input.shownCards,
  });
}
