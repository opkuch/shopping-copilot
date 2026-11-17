// Turns extracted slots into queries. Pure: no I/O, so every rule can be tested with plain objects.
import type { ExtractedIntent, ProductCard, Query } from "../messages/schema.ts";
import { SLUGS } from "../messages/schema.ts";
import { resolveCategory, splitGender } from "../slots/aliases.ts";
import { normalizeWord, normalizeWords } from "../slots/normalize.ts";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// Nouns that name no kind of product: "tennis gear" is about tennis, "kitchen stuff" about the kitchen.
// As a noun they must appear in a title, which none does, so the search missed.
const GENERIC_NOUNS = new Set(["gear", "stuff", "item", "thing", "product", "equipment", "something", "anything", "kit"]);

// The model is asked for one head noun, but a stray "phone case" must not dodge the denylist.
function normalizeNoun(noun: string | null): string | null {
  if (noun === null) return null;
  const words = noun.split(/\s+/).map(normalizeWord).filter((w): w is string => w !== null);
  if (words.length === 1 && GENERIC_NOUNS.has(words[0] as string)) return null;
  return words.length === 0 ? null : words.join(" ");
}

/**
 * "Basketball" arrives as noun "ball" plus attribute "basketball"; no product has both words, so the
 * attribute that already ends with the noun becomes the noun ("football", "headphone" + "phone").
 */
export function foldCompound(noun: string | null, attributes: string[]): { noun: string | null; attributes: string[] } {
  if (noun === null || noun.includes(" ")) return { noun, attributes };
  const compound = attributes.find((a) => !a.includes(" ") && a.length > noun.length + 2 && a.endsWith(noun));
  if (compound === undefined) return { noun, attributes };
  return { noun: compound, attributes: attributes.filter((a) => a !== compound) };
}

/**
 * A bound below zero means nothing. In one message, "between 2000 and 500" means the user swapped
 * them; across turns ("cheaper" under a stored minimum) an empty range is a real, honest miss.
 */
function bounds(min: number | null, max: number | null, swap: boolean): { priceMin: number | null; priceMax: number | null } {
  const lo = min !== null && min > 0 ? min : null;
  const hi = max !== null && max >= 0 ? max : null;
  return swap && lo !== null && hi !== null && lo > hi ? { priceMin: hi, priceMax: lo } : { priceMin: lo, priceMax: hi };
}

/**
 * A singular superlative: "the cheapest Samsung", "the most expensive men's Rolex", "which is rated highest".
 * Plural ones ("the cheapest phones") are a sorted list.
 */
export function asksForTop(utterance: string): boolean {
  const m = /\b(?:cheapest|priciest|dearest|most expensive|least expensive|(?:highest|best|top)[- ]rated|rated (?:the )?(?:highest|best)|lowest[- ]priced?)\b(?:\s+(\S+))?/i.exec(utterance);
  return m !== null && !/[^s'’]s[?!.,]*$/i.test(m[1] ?? "");
}

/** Which order a superlative asks for: "the cheapest", "most expensive", "best rated". Null when none. */
export function superlativeSort(utterance: string): "price_asc" | "price_desc" | "rating" | null {
  if (!asksForTop(utterance)) return null;
  if (/cheapest|least expensive|lowest[- ]priced?/i.test(utterance)) return "price_asc";
  if (/most expensive|priciest|dearest/i.test(utterance)) return "price_desc";
  if (/rated/i.test(utterance)) return "rating";
  return null;
}

// "Around $300", "about 50", "~100": a target, not an exact price and not a ceiling.
const APPROX_CUE = String.raw`(?:\b(?:around|about|roughly|approximately|approx\.?|circa|close\s+to)\s*|~\s*)\$?\s*`;
/** How far an approximate price reaches: down to half of it (a budget is rarely a floor), up by a quarter. */
export const APPROX_BELOW = 0.5;
export const APPROX_ABOVE = 0.25;

/** The ways a number can be written: "1000", "1,000", and "1k" for whole thousands. */
function numberPattern(n: number): string {
  const digits = String(Math.round(n));
  const forms = [digits, digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")];
  if (n >= 1000 && n % 1000 === 0) forms.push(`${n / 1000}k`);
  return `(?:${forms.join("|")})`;
}

/** "Around" is written right before this number ("about $50"), not anywhere in the message ("about 3 shirts under $50"). */
function approximateAt(utterance: string, n: number): boolean {
  return new RegExp(String.raw`${APPROX_CUE}${numberPattern(n)}(?![\d,])`, "i").test(utterance);
}

/**
 * The extractor reads "around $300" as 300..300 (the prompt asks it to); a single bound written right after
 * "around" means the same. An exact price point would find nothing in most categories, so it becomes a range.
 * A bound that "around" isn't attached to stays exact: "about 3 shirts under $50" is still under $50.
 */
export function approximate(min: number | null, max: number | null, utterance: string): { priceMin: number | null; priceMax: number | null } {
  const single = (min === null) !== (max === null) ? (min ?? max) : null;
  const point = min !== null && max !== null && min === max ? min
    : single !== null && approximateAt(utterance, single) ? single : null;
  if (point === null || point <= 0) return { priceMin: min, priceMax: max };
  return { priceMin: round2(point * (1 - APPROX_BELOW)), priceMax: round2(point * (1 + APPROX_ABOVE)) };
}

/** The intent's price bounds in dollars, or none when they were given in another currency. */
function dollarBounds(intent: ExtractedIntent, utterance: string): { priceMin: number | null; priceMax: number | null; notApplied: boolean } {
  const stated = intent.priceMin !== null || intent.priceMax !== null;
  if (intent.currency === "other" && stated) return { priceMin: null, priceMax: null, notApplied: true };
  return { ...approximate(intent.priceMin, intent.priceMax, utterance), notApplied: false };
}

// "Both under 50", "under 50 each", "all under 50", "everything under 50": the message says one bound covers
// every product. Not any "all" or "every": "an all-purpose cleaner" or "for every day" says nothing about price.
const COVERS_ALL = /\b(?:both|each)\b|\b(?:all|everything)\s+(?:of\s+(?:them|these|it)\s+)?(?:under|below|over|above|less|more|up|around|for|at)\b/i;

/**
 * Where the user wrote this intent's product: its noun, else one of its attributes ("laptop", "apple").
 * -1 if none of them is in the text (the extractor may normalize "kicks" to "sneaker").
 */
function mentionAt(text: string, intent: ExtractedIntent): number {
  const lower = text.toLowerCase();
  const words = [intent.noun, ...(intent.attributes ?? [])].filter((w): w is string => w !== null);
  for (const word of words) {
    const clean = word.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    if (clean === "") continue;
    const m = new RegExp(`\\b${clean}`).exec(lower);
    if (m !== null) return m.index;
  }
  return -1;
}

// A word or sign that makes the next number a price, not a model ("an iPhone 15") or a count ("2 laptops").
const PRICE_CUE = String.raw`(?:under|below|over|above|less\s+than|more\s+than|up\s+to|max(?:imum)?|budget(?:\s+of)?|between|around|about|for|at|\$)\s*\$?\s*`;

/**
 * Where the bound is written: the bound's own number after a price word ("an iPhone 15 case and a charger
 * under 15" is the second 15), else the bound's own number anywhere ("50 or less"), else the first number
 * after a price word.
 */
function boundAt(text: string, bound: number | null): number {
  if (bound !== null) {
    const num = numberPattern(bound);
    const cued = new RegExp(String.raw`${PRICE_CUE}${num}(?![\d,])`, "i").exec(text);
    if (cued !== null) return cued.index;
    const own = new RegExp(String.raw`(?<![\d.,])${num}(?![\d,])`, "i").exec(text);
    if (own !== null) return own.index;
  }
  const cue = new RegExp(String.raw`${PRICE_CUE}\d`, "i").exec(text);
  return cue === null ? -1 : cue.index;
}

/**
 * "A laptop and a perfume under 50": a price belongs to the product it is written next to. The extractor is
 * told so, but sometimes copies the bound onto several intents. When products carry the same bound and the
 * message doesn't say it covers them all ("both", "each", "all"), the bound stays only on the product named
 * nearest before the number. A bound written before the list ("under 50: a laptop and a perfume") covers all.
 */
export function scopePrices(intents: ExtractedIntent[], text: string): ExtractedIntent[] {
  if (intents.length < 2 || COVERS_ALL.test(text)) return intents;
  const boundOf = (i: ExtractedIntent) => (i.priceMin === null && i.priceMax === null ? null : `${i.priceMin}-${i.priceMax}`);
  let out = intents;
  // Each bound shared by several products is one the extractor may have copied: "eggs, sunscreen under $20,
  // a phone case" with $20 on all three keeps it on the sunscreen only.
  for (const bound of new Set(intents.map(boundOf))) {
    if (bound === null) continue;
    const sharing = intents.flatMap((i, idx) => (boundOf(i) === bound ? [idx] : []));
    if (sharing.length < 2) continue;
    const first = intents[sharing[0] as number] as ExtractedIntent;
    const price = boundAt(text, first.priceMax ?? first.priceMin);
    const at = sharing.map((idx) => mentionAt(text, intents[idx] as ExtractedIntent));
    if (price < 0 || at.includes(-1)) continue;
    // The product named nearest before the number owns it. None before it: written before the list, it covers all.
    let owner = -1;
    let nearest = -1;
    sharing.forEach((idx, j) => {
      const pos = at[j] as number;
      if (pos < price && pos > nearest) { nearest = pos; owner = idx; }
    });
    if (owner === -1) continue;
    out = out.map((intent, idx) => (sharing.includes(idx) && idx !== owner ? { ...intent, priceMin: null, priceMax: null, currency: null } : intent));
  }
  return out;
}

const excludeWords = (intent: ExtractedIntent): string[] => normalizeWords(intent.exclude) ?? [];

export type NewQuery = { query: Query; currencyNotApplied: boolean };

/** New search: `null` means "no such constraint" and `clear` is ignored. */
export function intentToQuery(intent: ExtractedIntent, utterance: string): NewQuery {
  const split = splitGender(normalizeWords(intent.attributes) ?? []);
  const { noun, attributes } = foldCompound(normalizeNoun(intent.noun), split.rest);
  const resolved = resolveCategory({ category: intent.category, noun, attributes, utterance });
  const price = dollarBounds(intent, utterance);
  return {
    currencyNotApplied: price.notApplied,
    query: {
      ...resolved,
      gender: split.gender,
      ...bounds(price.priceMin, price.priceMax, true),
      // No order asked for: words first, then rating (retrieval/filter.ts).
      sort: intent.sort ?? "relevance",
      top: asksForTop(utterance),
      inStock: intent.inStock ?? false,
      exclude: excludeWords(intent),
      within: null, purpose: null, offset: 0,
    },
  };
}

export type Patched = {
  query: Query;
  /** Set when "cheaper"/"pricier" was applied: the shown price the new bound was derived from. */
  cheaperThan: number | null;
  pricierThan: number | null;
  currencyNotApplied: boolean;
};

/** A gender change moves a gendered category to its counterpart: men's watches -> women's watches. */
function swapGender(category: Query["category"], gender: Query["gender"]): Query["category"] {
  if (category === null || gender === null) return category;
  const [from, to] = gender === "womens" ? ["mens-", "womens-"] : ["womens-", "mens-"];
  if (!category.startsWith(from)) return category;
  const other = to + category.slice(from.length);
  return (SLUGS as readonly string[]).includes(other) ? (other as Query["category"]) : category;
}

/** Refine: `null` keeps the stored value, a value replaces it, `clear` resets it to the default. */
export function patchQuery(stored: Query, intent: ExtractedIntent, utterance: string, shown: ProductCard[]): Patched {
  let { category, noun, priceMin, priceMax, sort, inStock, gender } = stored;
  let attributes = stored.attributes;

  // Clear first, so a value given in the same intent still wins over the reset.
  for (const field of intent.clear) {
    if (field === "category") category = null;
    else if (field === "noun") noun = null;
    else if (field === "attributes") attributes = [];
    else if (field === "price") priceMin = priceMax = null;
    else if (field === "sort") sort = "relevance";
    else inStock = false;
  }

  if (intent.category !== null) category = intent.category;
  // A noun that is all denylist words says nothing, so it keeps the stored one rather than clearing it.
  const newNoun = normalizeNoun(intent.noun);
  if (newNoun !== null) noun = newNoun;
  // An empty list is read like null (keep the stored words): clearing them is what `clear` is for, so a model
  // that writes [] for "nothing new" can't erase "white" or "leather" by accident.
  if (intent.attributes !== null && intent.attributes.length > 0) {
    const split = splitGender(normalizeWords(intent.attributes) ?? []);
    if (split.gender !== null) gender = split.gender;
    // "only women's" names a gender and nothing else: it keeps the stored color or material.
    if (split.rest.length > 0 || split.gender === null) attributes = split.rest;
  }

  // Price is one constraint. A message that says anything about it (a bound, "cheaper", "more expensive")
  // replaces the stored range instead of merging into it: "more expensive" after "under $200" is above the
  // cards shown with no cap, and "over $500" after "under $200" is over $500, never an empty $500-$200.
  // A message that says nothing about price keeps the range.
  const price = dollarBounds(intent, utterance);
  const prices = shown.map((p) => p.price);
  // "Cheaper" and "more expensive" are measured from the cards shown, else the old range's edge
  // ("more expensive" after "laptops under $1000" found nothing is over $1000).
  const cheaperThan = intent.relativePrice !== "cheaper" ? null
    : prices.length > 0 ? Math.min(...prices) : stored.priceMin;
  const pricierThan = intent.relativePrice !== "pricier" ? null
    : prices.length > 0 ? Math.max(...prices) : stored.priceMax;
  const statesBound = price.priceMin !== null || price.priceMax !== null;
  if (statesBound || cheaperThan !== null || pricierThan !== null) {
    priceMin = statesBound ? price.priceMin : null;
    priceMax = statesBound ? price.priceMax : null;
    if (cheaperThan !== null) priceMax = round2(cheaperThan - 0.01);
    if (pricierThan !== null) priceMin = round2(pricierThan + 0.01);
  }
  // "And for a woman?" on men's watches is women's watches, not an empty men's category.
  if (gender !== stored.gender) category = swapGender(category, gender);

  if (intent.sort !== null) sort = intent.sort;
  if (intent.inStock !== null) inStock = intent.inStock;

  ({ noun, attributes } = foldCompound(noun, attributes));
  const resolved = resolveCategory({
    category, noun, attributes, utterance,
    previouslyStated: stored.categoryStated ? stored.category : null,
  });
  return {
    cheaperThan, pricierThan, currencyNotApplied: price.notApplied,
    // "Top" belongs to the message that said it: "under 500" after "the cheapest" is a list again.
    // A gift or curated browse keeps its set of categories until the user names a product or category.
    query: {
      ...resolved, gender, ...bounds(priceMin, priceMax, false), sort, inStock, top: asksForTop(utterance),
      // "Not Apple" adds to what was ruled out; nothing in a refine brings a ruled-out brand back but a new search.
      exclude: [...new Set([...stored.exclude, ...excludeWords(intent)])],
      within: resolved.category === null && resolved.noun === null ? stored.within : null,
      purpose: resolved.category === null && resolved.noun === null ? stored.purpose : null,
      offset: 0, // any change starts the list again; "show more" sets it
    },
  };
}
