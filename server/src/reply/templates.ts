// Every fixed sentence of a reply. Used when no model writes the text, and when the prose call fails or
// is skipped. Category display names come from the cached list passed in; with no cache we show the slug,
// never a name from model memory.
import type { Group, Query, Slug } from "../messages/schema.ts";
import type { CategoryInfo, TurnFlags } from "../pipeline/ports.ts";

export type Names = CategoryInfo[] | null;

export type RelativePrice = { direction: "cheaper" | "pricier"; price: number };

/**
 * `requested` is the query before retrieval: a relaxed match erases words from `group.query`.
 * `keptPrevious`: the refine found nothing, so the earlier cards stay on screen under this sentence.
 */
export type GroupView = { group: Group; requested: Query; relative: RelativePrice | null; keptPrevious?: boolean };

// ---------- shared helpers ----------

export function categoryName(slug: string, names: Names): string {
  return names?.find((c) => c.slug === slug)?.name ?? slug;
}

/** One rule for every price in a sentence: whole dollars print bare ("$50"), anything else with cents ("$9.99"). */
export function money(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

const IRREGULAR_PLURAL: Record<string, string> = {
  knife: "knives", leaf: "leaves", shelf: "shelves", mouse: "mice", man: "men", woman: "women",
};
// Nouns with no plural. A count needs a unit: "3 jewellery items", never "3 jewellery".
const MASS = new Set(["jewellery", "jewelry", "furniture", "equipment", "clothing", "makeup", "skincare", "luggage", "cutlery"]);

// Nouns are stored singular; a sentence about several products needs the plural back.
export function plural(word: string): string {
  const irregular = IRREGULAR_PLURAL[word];
  if (irregular !== undefined) return irregular;
  if (MASS.has(word)) return word;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Group labels come from code, never the model: noun (pluralized, capitalized), else category display name, else "Products". */
export function labelFor(query: Query, names: Names): string {
  if (query.purpose === "gift" && query.noun === null && query.category === null) return "Gift ideas";
  if (query.purpose === "curated" && query.noun === null && query.category === null) return "Picks";
  if (query.noun !== null) {
    const label = plural(query.noun);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (query.category !== null) return categoryName(query.category, names);
  return "Products";
}

function hasNoConstraint(q: Query): boolean {
  return (
    q.category === null && q.noun === null && q.attributes.length === 0 &&
    q.priceMin === null && q.priceMax === null && !q.inStock
  );
}

function priceRange(q: Pick<Query, "priceMin" | "priceMax">): string {
  if (q.priceMin !== null && q.priceMax !== null) return ` between ${money(q.priceMin)} and ${money(q.priceMax)}`;
  if (q.priceMax !== null) return ` at or under ${money(q.priceMax)}`;
  if (q.priceMin !== null) return ` at or over ${money(q.priceMin)}`;
  return "";
}

// ---------- fixed replies ----------

const HELP = "I can help you find products in our catalog.";

// Read after "hi" and after "thanks" alike; the chips under it carry the next step.
export const greeting = () => "Happy to help. Tell me what you're looking for.";
// One reply for every service: a flight, a booking, "where is my order?". It names both kinds, since the router
// does not tell them apart, then says what we can do; the chips under it are example searches.
export const service = () => "I can't book trips or other services, or check on orders and deliveries; for an order, please contact the store's customer service. I can help you find products. Try one of these:";
export const offTopic = () => "That's outside what I can help with. I find products in this shop's catalog. Try one of these:";
export const refusal = () => `I can't help with that. ${HELP}`;
export const referNoCards = () => "There are no products on screen yet. What are you looking for?";
export const referUnclear = (n: number) =>
  n === 1 ? "Only one product is shown. Ask me about it, or tell me what else to look for."
  : `Which one? You can say a number from 1 to ${n} or a product name.`;

export function catalogOverview(names: Names): string {
  if (names === null || names.length === 0) return `${HELP} The category list is unavailable right now.`;
  return `${HELP} Categories include: ${names.map((c) => c.name).join(", ")}.`;
}

export function referText(title: string, detailUnavailable: boolean): string {
  const base = `Here are more details about ${title}.`;
  return detailUnavailable ? `${base} More details are unavailable right now.` : base;
}

/** The ask-once question when several searches are on screen and a change doesn't say which; chips answer it. */
export function whichGroup(labels: string[], op: "refine" | "remove"): string {
  const list = labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
  return op === "remove" ? `Which one should I remove: ${list}?` : `Which one should I change: ${list}?`;
}
export const removed = (label: string, left: string[]) => `Removed ${label}. Still on your list: ${left.join(", ")}.`;
export const removeOnly = () => "That's the only search on screen. Tell me what to look for instead.";

export const more = (label: string, from: number, to: number, total: number) =>
  from === to ? `Here is ${label} ${from} of ${total}.` : `Here are ${label} ${from} to ${to} of ${total}.`;
export const noMore = (label: string, total: number) => `That's all ${total} ${label} we have.`;

// ---------- results ----------

// Categories whose name is a countable thing. The rest ("Skin Care", "Groceries", "Mobile
// Accessories") are places, so a sentence counts "products in Skin Care", never "3 skin care".
const CATEGORY_NOUN: Partial<Record<Slug, [one: string, many: string]>> = {
  laptops: ["laptop", "laptops"], smartphones: ["smartphone", "smartphones"], tablets: ["tablet", "tablets"],
  fragrances: ["fragrance", "fragrances"], sunglasses: ["pair of sunglasses", "pairs of sunglasses"],
  tops: ["top", "tops"], motorcycle: ["motorcycle", "motorcycles"], vehicle: ["vehicle", "vehicles"],
  "mens-shirts": ["men's shirt", "men's shirts"], "mens-shoes": ["pair of men's shoes", "pairs of men's shoes"],
  "mens-watches": ["men's watch", "men's watches"], "womens-watches": ["women's watch", "women's watches"],
  "womens-shoes": ["pair of women's shoes", "pairs of women's shoes"], "womens-bags": ["women's bag", "women's bags"],
  "womens-dresses": ["dress", "dresses"], "womens-jewellery": ["piece of jewellery", "pieces of jewellery"],
};

// Noun is the most specific thing the user said, so it beats the category name.
function subject(q: Query, names: Names, one = false): string {
  if (q.noun !== null) {
    if (MASS.has(q.noun)) return `${q.noun} ${one ? "item" : "items"}`;
    return one ? q.noun : plural(q.noun);
  }
  if (q.category !== null) {
    const counted = CATEGORY_NOUN[q.category];
    if (counted) return one ? counted[0] : counted[1];
    return `${one ? "product" : "products"} in ${categoryName(q.category, names)}`;
  }
  return one ? "product" : "products";
}

/** "red laptops at or under $50, not Apple", built only from the query that was applied. */
export function constraints(q: Query, names: Names): string {
  const parts = [...q.attributes, subject(q, names)];
  const price = priceRange(q).trim();
  if (price !== "") parts.push(price);
  if (q.inStock) parts.push("that are in stock");
  const text = parts.join(" ");
  return q.exclude.length > 0 ? `${text}, not ${q.exclude.join(" or ")}` : text;
}

export const miss = (q: Query, names: Names) => `I couldn't find ${constraints(q, names)} in our catalog.`;
export const nothingCheaper = (price: number) => `Nothing in this search is cheaper than ${money(price)}.`;
export const nothingPricier = (price: number) => `Nothing in this search costs more than ${money(price)}.`;
export const keptPrevious = () => "The earlier results are still below.";

/** `kept`: the asked words every shown card still has. None kept: other products of the kind. */
export function attributesRelaxed(attributes: string[], things: string, kept: string[] = []): string {
  if (kept.length > 0) return `I couldn't find ${attributes.join(" ")} ${things}. Here are the closest matches.`;
  return `I couldn't find ${attributes.join(" ")} ${things} in our catalog. Here are other ${things}.`;
}

/** Asked words the shown cards don't all have. */
export const droppedAttributes = (requested: Query, applied: Query): string[] =>
  requested.attributes.filter((a) => !applied.attributes.includes(a));

/** The sentence over a gift or curated browse (Query.purpose), or null for any other group. */
function purposeSentence(q: Query, n: number): string | null {
  if (q.purpose === null) return null;
  if (q.purpose === "gift") {
    const who = q.gender === "mens" ? " for him" : q.gender === "womens" ? " for her" : "";
    return `Here are ${n} gift ideas${who}${priceRange(q)}, from different categories. Pick a budget or a kind of product to narrow it down.`;
  }
  // Only an order the shopper asked for is named; the default order is not a claim.
  const order = q.sort === "price_asc" ? " lowest-priced" : q.sort === "rating" ? " highly rated" : "";
  return `Here's a varied pick: ${n}${order} products from different categories. Tell me a budget or a kind of product to narrow it down.`;
}

export function resultsSentence(group: Group, names: Names): string {
  const q = group.query;
  const n = group.products.length;
  const { total } = group;
  const purposeLine = purposeSentence(q, n);
  if (purposeLine !== null) return purposeLine;
  // A browse shows one product per category (retrieval row "browse"), so say so.
  if (hasNoConstraint(q)) {
    const ask = "Tell me a category or a budget to narrow it down";
    if (q.sort === "price_asc") return `Here are the lowest-priced products from ${n} different categories. ${ask}.`;
    if (q.sort === "price_desc") return `Here are the highest-priced products from ${n} different categories. ${ask}.`;
    const examples = names?.slice(0, 3).map((c) => c.name) ?? [];
    const tail = examples.length > 0 ? `, for example: ${examples.join(", ")}.` : ".";
    return `Here are ${n} highly rated products from different categories. ${ask}${tail}`;
  }
  // "The cheapest phone?": the answer first, the runners-up stay as cards to compare.
  const first = group.products[0];
  if (q.top && first !== undefined && total > 1 && q.sort !== "relevance") {
    const word = q.sort === "price_asc" ? "lowest-priced" : q.sort === "price_desc" ? "highest-priced" : "highest-rated";
    const next = n > 1 ? " The next ones follow." : "";
    return `The ${word} of ${total} ${subject(q, names)} is ${first.title} at ${money(first.price)}.${next}`;
  }
  // The singular only fits when the one card is the whole result; "1 of 5 chargers" stays plural.
  const verb = n === 1 ? "is" : "are";
  const head = n === total
    ? `Here ${verb} ${n} ${subject(q, names, n === 1)}`
    : `Here ${verb} ${n} of ${total} ${subject(q, names)}`;
  if (q.sort === "price_asc") return `${head}, lowest price first.`;
  if (q.sort === "price_desc") return `${head}, highest price first.`;
  return `${head}.`;
}

function groupSentence(view: GroupView, names: Names): string | null {
  const { group, requested, relative } = view;
  if (group.status === "unavailable") return null;
  if (group.status === "miss") {
    if (relative?.direction === "cheaper") return nothingCheaper(relative.price);
    if (relative?.direction === "pricier") return nothingPricier(relative.price);
    return view.keptPrevious ? `${miss(group.query, names)} ${keptPrevious()}` : miss(group.query, names);
  }
  if (group.match === "attributes_relaxed") return attributesRelaxed(requested.attributes, subject(group.query, names), group.query.attributes);
  return resultsSentence(group, names);
}

const listOf = (labels: string[]) => (labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);

/**
 * A shopping list (three or more searches) in two sentences, not one per item: what was found, and every item
 * that found nothing, by name. The cards under each label say the rest.
 */
function listSentence(views: GroupView[]): string {
  const found = views.filter((v) => v.group.status === "results").map((v) => v.group.label);
  const missed = views.filter((v) => v.group.status === "miss").map((v) => v.group.label.toLowerCase());
  const closest = views.filter((v) => v.group.status === "results" && v.group.match === "attributes_relaxed").map((v) => v.group.label.toLowerCase());
  const head = found.length > 0 ? `Here's your list: ${found.length} of ${views.length} items found (${listOf(found)}).` : "I couldn't find anything on your list.";
  const tail = [
    ...(missed.length > 0 && found.length > 0 ? [`No match for ${listOf(missed)}.`] : []),
    ...(closest.length > 0 ? [`For ${listOf(closest)}, these are the closest matches.`] : []),
  ];
  return [head, ...tail].join(" ");
}

/** Template text for a product turn: one sentence per fetched group (a summary for a list), then one append per flag. */
export function resultsText(views: GroupView[], flags: TurnFlags, names: Names): string {
  const sentences: string[] = [];
  if (views.length >= 3) sentences.push(listSentence(views));
  else {
    for (const view of views) {
      const s = groupSentence(view, names);
      if (s !== null) sentences.push(s);
    }
  }
  if (flags.appliedToAll) sentences.push("I applied that to every search on screen.");
  if (flags.droppedIntents) sentences.push(`I looked up the first ${views.length} items; send the rest separately.`);
  if (flags.mentionsService) sentences.push("I can't book travel or other services.");
  if (flags.currencyNotApplied) sentences.push("Prices are in US dollars, so I didn't apply that price limit.");
  for (const view of views) {
    if (view.group.status === "unavailable") sentences.push(`I couldn't load ${view.group.label} right now.`);
  }
  return sentences.join(" ");
}
