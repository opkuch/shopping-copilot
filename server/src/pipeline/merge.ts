// Turns extracted slots into queries. Pure: no I/O, so every rule can be tested with plain objects.
import type { ExtractedIntent, ProductCard, Query } from "../messages/schema.ts";
import { SLUGS } from "../messages/schema.ts";
import type { CategoryInfo, RetrievalQuery } from "./ports.ts";
import { categoryName, plural } from "../reply/templates.ts";
import { resolveCategory, splitGender } from "../slots/aliases.ts";
import { normalizeWord, normalizeWords } from "../slots/normalize.ts";
import { ILS_PER_USD } from "./currency.ts";
import { CATEGORY_HE, NOUN_HE, PURPOSE_HE } from "../reply/hebrew.ts";

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
 * A singular superlative: "the cheapest Samsung", "הסמסונג הכי זול", "the most expensive men's Rolex".
 * Plural ones ("the cheapest phones", "הכי זולים") are a sorted list, as before.
 */
export function asksForTop(utterance: string): boolean {
  const he = /(?:הכי|ביותר)/.test(utterance) && !/(?:הכי\s+\S+(?:ים|ות)|\S+(?:ים|ות)\s+ביותר)(?:\s|$|[?.!,])/.test(utterance);
  // "rated highest" too: "which of all 15 is rated highest?" got "Which one? Say a number" three times.
  const en = /\b(?:cheapest|priciest|dearest|most expensive|least expensive|(?:highest|best|top)[- ]rated|rated (?:the )?(?:highest|best)|lowest[- ]priced?)\b(?:\s+(\S+))?/i.exec(utterance);
  const enSingular = en !== null && !/[^s'’]s$/i.test(en[1] ?? "");
  return he || enSingular;
}


const toUsd = (ils: number | null): number | null => (ils === null ? null : Math.round(ils / ILS_PER_USD));

const SHEKELS = /שקל|ש"ח|ש״ח|₪|\bnis\b|\bils\b|shekel/i;

/** The intent's bounds in dollars, and whether they were converted from shekels. */
function usdBounds(intent: ExtractedIntent, utterance = ""): { priceMin: number | null; priceMax: number | null; converted: boolean } {
  // The model sometimes calls shekels "other" ("טלפון עד 1000 שקל" once went unapplied).
  const ils = intent.currency === "ILS" || (intent.currency === "other" && SHEKELS.test(utterance));
  if (!ils) return { priceMin: intent.priceMin, priceMax: intent.priceMax, converted: false };
  const converted = intent.priceMin !== null || intent.priceMax !== null;
  return { priceMin: toUsd(intent.priceMin), priceMax: toUsd(intent.priceMax), converted };
}

/** Which order a superlative asks for: "the cheapest", "הכי יקר", "best rated". Null when none. */
export function superlativeSort(utterance: string): "price_asc" | "price_desc" | "rating" | null {
  if (!asksForTop(utterance) && !/(?:הכי|ביותר)/.test(utterance)) return null;
  if (/cheapest|least expensive|lowest[- ]priced?|זול/i.test(utterance)) return "price_asc";
  if (/most expensive|priciest|dearest|יקר/i.test(utterance)) return "price_desc";
  if (/rated|מדורג|טוב/i.test(utterance)) return "rating";
  return null;
}

// "Both under 50", "under 50 each", "all under 50": the message says one bound covers every product.
const COVERS_ALL = /\b(?:both|each|all|every)\b|שניהם|כל אחד|כולם/i;

/** Where the user wrote this intent's product: its noun, else its first attribute ("laptop", "apple"). -1 if not found. */
function mentionAt(text: string, intent: ExtractedIntent): number {
  const word = intent.noun ?? intent.attributes?.[0] ?? null;
  if (word === null) return -1;
  const m = new RegExp(`\\b${word.toLowerCase().replace(/[^a-z0-9 ]/g, "")}`).exec(text.toLowerCase());
  return m === null ? -1 : m.index;
}

/**
 * "A laptop and a perfume under 50": a price belongs to the product it is written next to. The extractor is
 * told so, but sometimes copies the bound onto both intents. When both carry the same bound and the message
 * doesn't say it covers both, the bound stays only on the product named nearest before the number. A bound
 * written before both products ("under 50: a laptop and a perfume") covers both. When a product word can't
 * be found in the text (a Hebrew message: the extracted nouns are English), nothing changes.
 */
export function scopePrices(intents: ExtractedIntent[], text: string): ExtractedIntent[] {
  if (intents.length !== 2) return intents;
  const [a, b] = intents as [ExtractedIntent, ExtractedIntent];
  const hasBound = a.priceMin !== null || a.priceMax !== null;
  if (!hasBound || a.priceMin !== b.priceMin || a.priceMax !== b.priceMax || COVERS_ALL.test(text)) return intents;
  const price = /\d/.exec(text)?.index ?? -1;
  const at = [mentionAt(text, a), mentionAt(text, b)];
  if (price < 0 || at.includes(-1)) return intents;
  const before = at.map((i) => (i < price ? i : -1));
  if (before[0] === -1 && before[1] === -1) return intents;
  const owner = (before[0] as number) > (before[1] as number) ? 0 : 1;
  return intents.map((intent, i) => (i === owner ? intent : { ...intent, priceMin: null, priceMax: null, currency: null }));
}

export type NewQuery = { query: RetrievalQuery; currencyNotApplied: boolean; currencyConverted: boolean };

/** New search: `null` means "no such constraint" and `clear` is ignored. */
export function intentToQuery(intent: ExtractedIntent, utterance: string): NewQuery {
  const split = splitGender(normalizeWords(intent.attributes) ?? []);
  const gender = split.gender;
  const { noun, attributes } = foldCompound(normalizeNoun(intent.noun), split.rest);
  const currencyNotApplied = intent.currency === "other" && !SHEKELS.test(utterance) && (intent.priceMin !== null || intent.priceMax !== null);
  // Nothing operational at all: a vague request gets the best-rated products.
  const vague = noun === null && attributes.length === 0 && intent.category === null;
  const resolved = resolveCategory({ category: intent.category, noun, attributes, utterance });
  const usd = usdBounds(intent, utterance);
  return {
    currencyNotApplied,
    currencyConverted: usd.converted,
    query: {
      ...resolved,
      gender,
      ...(currencyNotApplied ? { priceMin: null, priceMax: null } : bounds(usd.priceMin, usd.priceMax, true)),
      // No order asked for: words first, then rating (retrieval/filter.ts).
      sort: intent.sort ?? "relevance",
      top: asksForTop(utterance),
      inStock: intent.inStock ?? false,
      within: null, purpose: null, offset: 0,
    },
  };
}

export type Patched = {
  query: RetrievalQuery;
  /** Set when "cheaper"/"pricier" was applied: the shown price the new bound was derived from. */
  cheaperThan: number | null;
  pricierThan: number | null;
  currencyNotApplied: boolean;
  currencyConverted: boolean;
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
  if (intent.attributes !== null) {
    const split = splitGender(normalizeWords(intent.attributes) ?? []);
    if (split.gender !== null) gender = split.gender;
    // "only women's" names a gender and nothing else: it keeps the stored color or material.
    if (split.rest.length > 0 || split.gender === null) attributes = split.rest;
  }

  // Price is one constraint. A message that says anything about it (a bound, "cheaper", "more expensive")
  // replaces the stored range instead of merging into it: "more expensive" after "under $200" is above the
  // cards shown with no cap, and "over $500" after "under $200" is over $500, never an empty $500-$200.
  // A message that says nothing about price keeps the range.
  const currencyNotApplied = intent.currency === "other" && !SHEKELS.test(utterance) && (intent.priceMin !== null || intent.priceMax !== null);
  const usd = usdBounds(intent, utterance);
  const prices = shown.map((p) => p.price);
  // "Cheaper" and "more expensive" are measured from the cards shown, else the old range's edge
  // ("more expensive" after "laptops under $1000" found nothing is over $1000).
  const cheaperThan = intent.relativePrice !== "cheaper" ? null
    : prices.length > 0 ? Math.min(...prices) : stored.priceMin;
  const pricierThan = intent.relativePrice !== "pricier" ? null
    : prices.length > 0 ? Math.max(...prices) : stored.priceMax;
  const statesBound = !currencyNotApplied && (usd.priceMin !== null || usd.priceMax !== null);
  if (statesBound || cheaperThan !== null || pricierThan !== null) {
    priceMin = statesBound ? usd.priceMin : null;
    priceMax = statesBound ? usd.priceMax : null;
    if (cheaperThan !== null) priceMax = round2(cheaperThan - 0.01);
    if (pricierThan !== null) priceMin = round2(pricierThan + 0.01);
  }
  // "And for a woman?" on men's watches is women's watches, not an empty men's category.
  if (gender !== stored.gender) category = swapGender(category, gender);

  // "Which is the highest rated of all?" as a refine: the words decide the sort when the extractor gave none.
  if (intent.sort !== null) sort = intent.sort;
  else if (superlativeSort(utterance) !== null) sort = superlativeSort(utterance) as Query["sort"];
  if (intent.inStock !== null) inStock = intent.inStock;

  ({ noun, attributes } = foldCompound(noun, attributes));
  const resolved = resolveCategory({
    category, noun, attributes, utterance,
    previouslyStated: stored.categoryStated ? stored.category : null,
  });
  return {
    cheaperThan, pricierThan, currencyNotApplied, currencyConverted: usd.converted,
    // "Top" belongs to the message that said it: "under 500" after "the cheapest" is a list again.
    // A gift or curated browse keeps its set of categories until the user names a product or category.
    query: {
      ...resolved, gender, ...bounds(priceMin, priceMax, false), sort, inStock, top: asksForTop(utterance),
      within: resolved.category === null && resolved.noun === null ? stored.within : null,
      purpose: resolved.category === null && resolved.noun === null ? stored.purpose : null,
      offset: 0, // any change starts the list again; "show more" sets it
    },
  };
}

/** Group labels come from code, never the model: noun (pluralized, capitalized), else category display name, else "Products". */
export function labelFor(query: Query, categoryNames: CategoryInfo[] | null, language: "en" | "he" = "en"): string {
  if (language === "he") {
    const bare = query.noun === null && query.category === null;
    if (bare && query.purpose !== null) return PURPOSE_HE[query.purpose];
    if (query.noun !== null && NOUN_HE[query.noun] !== undefined) return NOUN_HE[query.noun] as string;
    if (query.category !== null) return CATEGORY_HE[query.category];
    if (query.noun === null) return "מוצרים";
  }
  if (query.purpose === "gift" && query.noun === null && query.category === null) return "Gift ideas";
  if (query.purpose === "curated" && query.noun === null && query.category === null) return "Picks";
  if (query.noun !== null) {
    const label = plural(query.noun);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (query.category !== null) return categoryName(query.category, categoryNames);
  return "Products";
}
