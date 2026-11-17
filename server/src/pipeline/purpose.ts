// Requests that name no product: a gift, "surprise me", "something cheap and cool". The model only reports
// what the user said (a gift, a recipient); code decides which categories the set comes from, and the chips
// offered to narrow it. The tables below are product decisions, reviewed like code.
import type { ConversationMemory, ExtractedIntent, Gender, PurposeContext, Slug, Suggestion } from "../messages/schema.ts";
import { money } from "../reply/templates.ts";
import { KID_WORDS } from "../slots/aliases.ts";
import { singularize } from "../slots/normalize.ts";

/** Categories a gift may come from, by recipient. No groceries, vehicles, kitchen or furniture. */
export const GIFT_CATEGORIES: Record<"mens" | "womens" | "kid" | "any", Slug[]> = {
  mens: ["fragrances", "mens-watches", "mens-shirts", "mens-shoes", "mobile-accessories", "sunglasses", "sports-accessories"],
  womens: ["womens-jewellery", "fragrances", "womens-bags", "beauty", "womens-watches", "womens-shoes", "sunglasses", "skin-care"],
  // No kids' products in the catalog: balls, rackets and sunglasses suit a child; phone gadgets ($349 watches) don't.
  kid: ["sports-accessories", "sunglasses"],
  any: ["fragrances", "womens-jewellery", "beauty", "mobile-accessories", "sunglasses", "home-decoration"],
};

export function giftCategories(ctx: { kid: boolean; gender: Gender | null }): Slug[] {
  return ctx.kid ? GIFT_CATEGORIES.kid : GIFT_CATEGORIES[ctx.gender ?? "any"];
}

/** "Surprise me", "something cheap and cool": a varied set that a browse can stand behind. No kitchen: its
 * cheapest products are forks, plates and spoons, which answer "cheap" but not "cool". */
export const CURATED: Slug[] = [
  "beauty", "fragrances", "sunglasses", "home-decoration", "sports-accessories", "mobile-accessories", "womens-jewellery",
];

// A boy or a girl is a child too ("boy" and "girl" also set the gender).
const isChild = (word: string) => { const w = singularize(word); return KID_WORDS.has(w) || w === "boy" || w === "girl"; };
/** The message says the product is for a child ("for my 8 year old", "a kid"). */
export const mentionsChild = (intent: ExtractedIntent) => (intent.attributes ?? []).some(isChild);

export type BrowsePlan = { within: Slug[]; purpose: "gift" | "curated"; gender: Gender | null; kid: boolean };

/**
 * An intent that names no product, category or word is a browse: gift ideas for the recipient, or the
 * curated set when nothing at all is said but an order or a gender. Null: the normal search runs (a price
 * alone, "anything under 20", is a normal browse over the catalog). A gift never waits on a question: the
 * ideas come at once, and the chips under them narrow by budget, recipient and kind.
 */
export function planPurpose(
  intent: ExtractedIntent, q: { category: Slug | null; noun: string | null; attributes: string[]; gender: Gender | null; priceMin: number | null; priceMax: number | null },
): BrowsePlan | null {
  if (q.category !== null || q.noun !== null || q.attributes.length > 0) return null;
  const kid = mentionsChild(intent);
  if (intent.gift === true) return { within: giftCategories({ kid, gender: q.gender }), purpose: "gift", gender: q.gender, kid };
  if (q.priceMin === null && q.priceMax === null) return { within: kid ? GIFT_CATEGORIES.kid : CURATED, purpose: "curated", gender: q.gender, kid };
  return null;
}

/**
 * The chips under gift ideas. Each text carries the whole request ("a gift for her up to $50"), so a tap is a
 * complete search on its own and nothing has to be remembered for it to work.
 */
export function giftSuggestions(p: { gender: Gender | null; kid: boolean; priceMax: number | null }): Suggestion[] {
  const who = p.kid ? "for a kid" : p.gender === "mens" ? "for him" : p.gender === "womens" ? "for her" : null;
  const budget = p.priceMax === null ? "" : ` up to ${money(p.priceMax)}`;
  const out: Suggestion[] = [];
  if (who === null) {
    out.push({ label: "For him", text: `a gift for him${budget}` }, { label: "For her", text: `a gift for her${budget}` });
  }
  if (p.priceMax === null) {
    for (const n of [50, 100, 200]) out.push({ label: `Up to $${n}`, text: `a gift ${who ?? ""} up to $${n}`.replace(/\s+/g, " ") });
  }
  const kinds = p.kid ? ["ball", "sunglasses", "racket"]
    : p.gender === "mens" ? ["perfume", "watch", "headphones"]
    : p.gender === "womens" ? ["jewelry", "perfume", "bag"]
    : ["perfume", "headphones", "jewelry"];
  for (const k of kinds) out.push({ label: k.charAt(0).toUpperCase() + k.slice(1), text: `a ${k} as a gift ${who ?? ""}${budget}`.replace(/\s+/g, " ").trim() });
  return out.slice(0, 8);
}

/** Chips under a curated set: narrow it in one tap. */
export function narrowSuggestions(): Suggestion[] {
  return [
    { label: "Up to $50", text: "something under $50" }, { label: "A gift", text: "I'm looking for a gift" },
    { label: "Perfume", text: "perfume" }, { label: "Headphones", text: "headphones" },
  ];
}

/** Example searches under a reply that cannot help (service, off topic): always a next step. */
export function starterSuggestions(): Suggestion[] {
  return [
    { label: "Headphones under $100", text: "headphones under $100" }, { label: "A gift for mom", text: "a gift for my mom" },
    { label: "Cheap sunglasses", text: "cheap sunglasses" },
  ];
}

/**
 * A miss never ends the chat: drop the price limit (never relaxed by itself, so the shopper decides), or try
 * an example search. Each text is one the router and the extractor already handle.
 */
export function missSuggestions(q: { priceMin: number | null; priceMax: number | null } | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (q !== null && (q.priceMin !== null || q.priceMax !== null)) out.push({ label: "Any price", text: "any price" });
  for (const s of starterSuggestions()) if (out.length < 3) out.push(s);
  return out;
}

/**
 * Next steps under a results reply, decided by code from what is on screen (never by a model): more of
 * the same, cheaper, in stock only. Each text is one the router handles.
 */
export function nextStepSuggestions(
  groups: Array<{ status: string; total: number; products: Array<{ inStock: boolean }>; query?: { priceMin: number | null; priceMax: number | null } }>,
  opts: { noCheaper?: boolean } = {},
): Suggestion[] {
  const shown = groups.flatMap((g) => g.products);
  if (shown.length === 0) return missSuggestions(groups.find((g) => g.status === "miss")?.query ?? null);
  const out: Suggestion[] = [];
  if (groups.length === 1 && groups.some((g) => g.status === "results" && g.total > g.products.length)) {
    out.push({ label: "Show more", text: "show more" });
  }
  if (groups.length === 1 && !opts.noCheaper) out.push({ label: "Cheaper", text: "something cheaper" });
  if (shown.some((p) => !p.inStock)) out.push({ label: "In stock only", text: "only what's in stock" });
  return out;
}

/**
 * The shopper rejected what is on screen: back to the conversation's purpose without the rejected kinds.
 * A gift for her: her gift categories minus those; no purpose: the curated set minus those.
 */
export function rejectionBrowse(memory: ConversationMemory, rejected: Slug[], gender: Gender | null):
  { within: Slug[]; purpose: "gift" | "curated"; gender: Gender | null; excluded: Slug[] } {
  const excluded = [...new Set([...memory.excluded, ...rejected])];
  const p: PurposeContext | null = memory.purpose;
  const g = gender ?? p?.gender ?? null;
  const base = p?.gift ? giftCategories({ kid: p.kid, gender: g }) : CURATED;
  let within = base.filter((c) => !excluded.includes(c));
  if (within.length === 0) within = CURATED.filter((c) => !excluded.includes(c));
  return { within, purpose: p?.gift ? "gift" : "curated", gender: g, excluded };
}
