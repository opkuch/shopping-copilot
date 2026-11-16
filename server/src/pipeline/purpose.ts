// Vague requests: gifts, occasions, "surprise me". The model only reports what the user said (a gift, an
// occasion, a recipient); code decides whether to ask one question or show a set, and which categories a
// set may come from. The tables below are product decisions, reviewed like code.
import type { ConversationMemory, ExtractedIntent, Gender, PurposeContext, Slug, Suggestion } from "../messages/schema.ts";
import type { Lang } from "../reply/language.ts";

// Occasion words the extractor may use for the same thing.
const OCCASION_ALIASES: Record<string, string> = {
  "valentine's day": "valentine", "valentines day": "valentine", valentines: "valentine", "valentine's": "valentine",
  "love day": "valentine", "wedding anniversary": "anniversary", "new home": "housewarming", "house warming": "housewarming",
};
// Occasions are gifts: what to buy depends on the person, so they are asked about like any gift.
const OCCASIONS = new Set(["wedding", "birthday", "anniversary", "holiday", "valentine", "graduation", "party", "housewarming", "mother's day", "father's day"]);

/** Categories a gift may come from, by recipient. No groceries, vehicles, or furniture. */
export const GIFT_CATEGORIES: Record<"mens" | "womens" | "kid" | "any", Slug[]> = {
  mens: ["fragrances", "mens-watches", "mens-shirts", "mens-shoes", "mobile-accessories", "sunglasses"],
  womens: ["womens-jewellery", "fragrances", "womens-bags", "beauty", "womens-watches", "womens-shoes", "sunglasses", "skin-care"],
  kid: ["sports-accessories", "mobile-accessories", "sunglasses"],
  // No kitchen: "a lunch box for Valentine's Day" is not a gift.
  any: ["fragrances", "womens-jewellery", "beauty", "mobile-accessories", "sunglasses", "home-decoration"],
};

/** Valentine's Day and anniversaries: something personal, by recipient. */
const ROMANTIC_OCCASIONS = new Set(["valentine", "anniversary"]);
export const ROMANTIC_CATEGORIES: Record<"mens" | "womens" | "any", Slug[]> = {
  womens: ["womens-jewellery", "fragrances", "womens-bags", "womens-watches", "beauty"],
  mens: ["fragrances", "mens-watches", "sunglasses", "mens-shirts"],
  any: ["fragrances", "womens-jewellery", "womens-bags", "mens-watches", "womens-watches", "beauty"],
};

/** The categories a gift comes from: a child's, a romantic occasion's, or the recipient's. */
export function giftCategories(ctx: { kid: boolean; gender: Gender | null; theme: string | null }): Slug[] {
  if (ctx.kid) return GIFT_CATEGORIES.kid;
  const theme = ctx.theme === null ? null : OCCASION_ALIASES[ctx.theme] ?? ctx.theme;
  if (theme !== null && ROMANTIC_OCCASIONS.has(theme)) return ROMANTIC_CATEGORIES[ctx.gender ?? "any"];
  return GIFT_CATEGORIES[ctx.gender ?? "any"];
}

/** "Surprise me", "something cheap and cool": a varied set that a browse can stand behind. No kitchen: its
 * cheapest products are forks, plates and spoons, which answer "cheap" but not "cool". */
export const CURATED: Slug[] = [
  "beauty", "fragrances", "sunglasses", "home-decoration", "sports-accessories", "mobile-accessories", "womens-jewellery",
];

const KID_WORDS = new Set(["kid", "child", "children", "toddler", "baby", "teen", "teenager", "boy", "girl"]);

export type PurposePlan =
  | { kind: "clarify"; context: PurposeContext; why: "gift_budget" | "unknown_theme" }
  | { kind: "browse"; within: Slug[]; purpose: "gift" | "curated"; gender: Gender | null; priceMin: number | null; priceMax: number | null; theme?: string }
  | null;

/**
 * What to do with an intent that names no product: ask, show a set, or nothing special (null: the
 * normal search runs). `gender` is the intent's gender after merge; `context` is what the previous
 * clarifying question already knew.
 */
export function planPurpose(
  intent: ExtractedIntent, q: { category: Slug | null; noun: string | null; attributes: string[]; gender: Gender | null; priceMin: number | null; priceMax: number | null; sort: string },
  context: PurposeContext | null,
): PurposePlan {
  const kid = (intent.attributes ?? []).some((a) => KID_WORDS.has(a.toLowerCase())) || (context?.kid ?? false);
  const rest = q.attributes.filter((a) => !KID_WORDS.has(a));
  if (q.category !== null || q.noun !== null || rest.length > 0) return null;

  const rawTheme = (intent.theme ?? context?.theme ?? null)?.trim().toLowerCase() ?? null;
  const theme = rawTheme === null ? null : OCCASION_ALIASES[rawTheme] ?? rawTheme;
  const gift = (intent.gift ?? false) || (context?.gift ?? false) || (theme !== null && OCCASIONS.has(theme));
  const gender = q.gender ?? context?.gender ?? null;
  const hasBudget = q.priceMin !== null || q.priceMax !== null;
  const ctx: PurposeContext = { gift, gender, kid, theme };

  // At most one question per request: a message that answers it ("for her") gets ideas with what is known,
  // and chips to narrow them, never the same question again.
  const asked = context !== null;
  if (gift) {
    if (!hasBudget && !asked) return { kind: "clarify", context: ctx, why: "gift_budget" };
    const within = giftCategories({ kid, gender, theme });
    return { kind: "browse", within, purpose: "gift", gender, priceMin: q.priceMin, priceMax: q.priceMax, ...(theme !== null ? { theme } : {}) };
  }
  // A place or activity with no product ("something for the beach"): one question, never a guessed set.
  if (theme !== null && !asked) return { kind: "clarify", context: ctx, why: "unknown_theme" };
  // Nothing at all to go on but a sort or a gender ("surprise me", "something cheap and cool"): the
  // curated browse. A price alone ("anything under 20") stays the normal browse over the catalog.
  if (!hasBudget) return { kind: "browse", within: kid ? GIFT_CATEGORIES.kid : CURATED, purpose: "curated", gender, priceMin: null, priceMax: null };
  return null;
}

/** The chips under a clarifying question: who it is for (when unknown), a budget, and a kind of product. */
export function clarifySuggestions(ctx: PurposeContext, lang: Lang): Suggestion[] {
  const he = lang === "he";
  const out: Suggestion[] = [];
  if (ctx.gift && ctx.gender === null && !ctx.kid) {
    out.push(he ? { label: "בשבילו", text: "בשבילו" } : { label: "For him", text: "for him" });
    out.push(he ? { label: "בשבילה", text: "בשבילה" } : { label: "For her", text: "for her" });
    out.push(he ? { label: "לילד", text: "בשביל ילד" } : { label: "For a kid", text: "for a kid" });
  }
  if (ctx.gift) {
    for (const n of [50, 100, 200]) out.push(he ? { label: `עד $${n}`, text: `עד ${n} דולר` } : { label: `Up to $${n}`, text: `up to $${n}` });
  }
  const kinds: Array<[string, string]> = ctx.kid
    ? [["כדור", "ball"], ["משקפי שמש", "sunglasses"], ["אוזניות", "headphones"]]
    : ctx.gender === "mens"
      ? [["בושם", "perfume"], ["שעון", "watch"], ["אוזניות", "headphones"]]
      : ctx.gender === "womens"
        ? [["תכשיטים", "jewelry"], ["בושם", "perfume"], ["תיק", "bag"]]
        : [["בושם", "perfume"], ["אוזניות", "headphones"], ["לבית", "something for the home"], ["תכשיטים", "jewelry"]];
  for (const [heLabel, en] of kinds) out.push(he ? { label: heLabel, text: heLabel } : { label: en.charAt(0).toUpperCase() + en.slice(1), text: en });
  return out.slice(0, 8);
}

/** Chips under a curated set: narrow it in one tap. */
export function narrowSuggestions(lang: Lang): Suggestion[] {
  return lang === "he"
    ? [{ label: "עד $50", text: "עד 50 דולר" }, { label: "מתנה", text: "אני מחפש מתנה" }, { label: "בושם", text: "בושם" }, { label: "אוזניות", text: "אוזניות" }]
    : [{ label: "Up to $50", text: "under $50" }, { label: "A gift", text: "I'm looking for a gift" }, { label: "Perfume", text: "perfume" }, { label: "Headphones", text: "headphones" }];
}

/** Example searches under a reply that cannot help (service, off topic): always a next step. */
export function starterSuggestions(lang: Lang): Suggestion[] {
  return lang === "he"
    ? [{ label: "אוזניות עד $100", text: "אוזניות עד 100 דולר" }, { label: "מתנה לאמא", text: "מתנה לאמא" }, { label: "משקפי שמש זולים", text: "משקפי שמש זולים" }]
    : [{ label: "Headphones under $100", text: "headphones under $100" }, { label: "A gift for mom", text: "a gift for my mom" }, { label: "Cheap sunglasses", text: "cheap sunglasses" }];
}

/**
 * Next steps under a results reply, decided by code from what is on screen (never by a model): more of
 * the same, cheaper, in stock only. Each text is one the router handles.
 */
export function nextStepSuggestions(
  groups: Array<{ status: string; total: number; products: Array<{ inStock: boolean }> }>, lang: Lang, opts: { noCheaper?: boolean } = {},
): Suggestion[] {
  const he = lang === "he";
  const shown = groups.flatMap((g) => g.products);
  if (shown.length === 0) return [];
  const out: Suggestion[] = [];
  if (groups.length === 1 && groups.some((g) => g.status === "results" && g.total > g.products.length)) {
    out.push(he ? { label: "עוד תוצאות", text: "תראה עוד" } : { label: "Show more", text: "show more" });
  }
  if (groups.length === 1 && !opts.noCheaper) out.push(he ? { label: "משהו זול יותר", text: "משהו זול יותר" } : { label: "Cheaper", text: "something cheaper" });
  if (shown.some((p) => !p.inStock)) out.push(he ? { label: "רק מה שבמלאי", text: "רק מה שבמלאי" } : { label: "In stock only", text: "only what's in stock" });
  return out;
}

/** The memory as the models read it: one short line each, or null when there is nothing to remember. */
export function describeMemory(m: ConversationMemory | null): { purpose: string | null; rejected: string[] } | null {
  if (m === null || (m.purpose === null && m.excluded.length === 0)) return null;
  const p = m.purpose;
  const who = p === null ? null : p.kid ? "a child" : p.gender === "mens" ? "a man" : p.gender === "womens" ? "a woman" : null;
  const purpose = p === null ? null : p.gift ? `a gift${who ? ` for ${who}` : ""}${p.theme ? ` (${p.theme})` : ""}` : p.theme ? `something for ${p.theme}` : null;
  return { purpose, rejected: m.excluded };
}


/**
 * The shopper rejected what is on screen: back to the conversation's purpose without the rejected kinds.
 * A gift for her: her gift categories minus those; no purpose: the curated set minus those.
 */
export function rejectionBrowse(memory: ConversationMemory, rejected: Slug[], gender: Gender | null, priceMax: number | null, priceMin: number | null):
  { within: Slug[]; purpose: "gift" | "curated"; gender: Gender | null; priceMin: number | null; priceMax: number | null; excluded: Slug[] } {
  const excluded = [...new Set([...memory.excluded, ...rejected])];
  const p = memory.purpose;
  const g = gender ?? p?.gender ?? null;
  const base = p?.gift ? giftCategories({ kid: p.kid, gender: g, theme: p.theme }) : CURATED;
  let within = base.filter((c) => !excluded.includes(c));
  if (within.length === 0) within = CURATED.filter((c) => !excluded.includes(c));
  return { within, purpose: p?.gift ? "gift" : "curated", gender: g, priceMin, priceMax, excluded };
}
