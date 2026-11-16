// Every fixed sentence of the reply, per language.
// Used when no model writes the text, and when the prose call fails or is skipped.
// Category display names come from the cached list passed in; with no cache we show the slug,
// never a name from model memory. Product titles, labels, and category names are catalog data and
// stay in English in every language; the sentence around them is translated.
import type { Group, PurposeContext, Query, Slug } from "../messages/schema.ts";
import { ILS_PER_USD } from "../pipeline/currency.ts";
import type { CategoryInfo, TurnFlags } from "../pipeline/ports.ts";
import type { Lang } from "./language.ts";

export type Names = CategoryInfo[] | null;

export type RelativePrice = { direction: "cheaper" | "pricier"; price: number };

/**
 * `requested` is the query before retrieval: a fallback erases words from `group.query`.
 * `keptPrevious`: the refine found nothing, so the earlier cards stay on screen under this sentence.
 */
export type GroupView = { group: Group; requested: Query; relative: RelativePrice | null; keptPrevious?: boolean };

export interface Templates {
  greeting(): string;
  service(): string;
  offTopic(): string;
  refusal(): string;
  referNoCards(): string;
  referUnclear(n: number): string;
  askWhichGroup(label1: string, label2: string): string;
  catalogOverview(names: Names): string;
  referText(title: string, detailUnavailable: boolean): string;
  resultsText(views: GroupView[], flags: TurnFlags, names: Names): string;
  /** One question for a vague request; the chips under it answer it in one tap. */
  clarify(why: "gift_budget" | "unknown_theme", ctx: PurposeContext): string;
  /** "Show more": cards from..to of total. */
  more(label: string, from: number, to: number, total: number): string;
  noMore(label: string, total: number): string;
}

/** The sentence over a gift or curated browse (Query.purpose), or null for any other group. */
function purposeSentence(q: Query, n: number, he: boolean): string | null {
  if (q.purpose === null) return null;
  const price = he ? hePrice(q) : enPrice(q);
  if (q.purpose === "gift") {
    const who = q.gender === "mens" ? (he ? " בשבילו" : " for him") : q.gender === "womens" ? (he ? " בשבילה" : " for her") : "";
    return he ? `הנה ${n} רעיונות למתנה${who}${price}, מקטגוריות שונות. אפשר לבחור סוג מוצר כדי לצמצם.`
      : `Here are ${n} gift ideas${who}${price}, from different categories. Pick a kind of product to narrow it down.`;
  }
  // Only an order the shopper asked for is named; the default order is not a claim.
  const order = q.sort === "price_asc" ? (he ? " הזולים ביותר" : " lowest-priced") : q.sort === "rating" ? (he ? " עם דירוג גבוה" : " highly rated") : "";
  return he ? `הנה מבחר: ${n} מוצרים${order} מקטגוריות שונות. אפשר לציין תקציב או סוג מוצר כדי לצמצם.`
    : `Here's a varied pick: ${n}${order} products from different categories. Tell me a budget or a kind of product to narrow it down.`;
}

function enPrice(q: Query): string {
  if (q.priceMin !== null && q.priceMax !== null) return ` between ${money(q.priceMin)} and ${money(q.priceMax)}`;
  if (q.priceMax !== null) return ` at or under ${money(q.priceMax)}`;
  if (q.priceMin !== null) return ` at or over ${money(q.priceMin)}`;
  return "";
}

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

export function hasNoConstraint(q: Query): boolean {
  return (
    q.category === null && q.noun === null && q.attributes.length === 0 &&
    q.priceMin === null && q.priceMax === null && !q.inStock
  );
}

// ---------- English ----------

const HELP = "I can help you find products in our catalog.";

export const greeting = () => HELP;
// One reply for every service: a flight, a booking, "where is my order?". It names both kinds, since the router
// does not tell them apart, then says what we can do; the chips under it are example searches.
export const service = () => "I can't book trips or other services, or check on orders and deliveries; for an order, please contact the store's customer service. I can help you find products. Try one of these:";
export const offTopic = () => "That's outside what I can help with. I find products in this shop's catalog. Try one of these:";
export const refusal = () => `I can't help with that. ${HELP}`;
export const referNoCards = () => "There are no products on screen yet. What are you looking for?";
export const referUnclear = (n: number) => `Which one? You can say a number from 1 to ${n} or a product name.`;
export const askWhichGroup = (label1: string, label2: string) => `Which one should I change: ${label1} or ${label2}?`;

export function catalogOverview(names: Names): string {
  if (names === null || names.length === 0) return `${HELP} The category list is unavailable right now.`;
  return `${HELP} Categories include: ${names.map((c) => c.name).join(", ")}.`;
}

export function referText(title: string, detailUnavailable: boolean): string {
  const base = `Here are more details about ${title}.`;
  return detailUnavailable ? `${base} More details are unavailable right now.` : base;
}

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

/** "red laptops at or under $50", built only from the query that was applied. */
export function constraints(q: Query, names: Names): string {
  const parts = [...q.attributes, subject(q, names)];
  if (q.priceMin !== null && q.priceMax !== null) parts.push(`between ${money(q.priceMin)} and ${money(q.priceMax)}`);
  else if (q.priceMax !== null) parts.push(`at or under ${money(q.priceMax)}`);
  else if (q.priceMin !== null) parts.push(`at or over ${money(q.priceMin)}`);
  if (q.inStock) parts.push("that are in stock");
  return parts.join(" ");
}

export const miss = (q: Query, names: Names) => `I couldn't find ${constraints(q, names)} in our catalog.`;
export const nothingCheaper = (price: number) => `Nothing in this search is cheaper than ${money(price)}.`;
export const nothingPricier = (price: number) => `Nothing in this search costs more than ${money(price)}.`;

// The words are quoted: they are what the user typed, not a noun phrase ("battery" in "a phone with
// good battery" read as "I couldn't find battery in Smartphones").
export function categoryFallback(words: string[], category: string): string {
  return `Nothing in ${category} matches "${words.join(" ")}". Here are other products in ${category}.`;
}

export const keptPrevious = () => "The earlier results are still below.";

/** `kept`: the asked words every shown card still has. None kept: other products of the kind. */
export function attributesRelaxed(attributes: string[], things: string, kept: string[] = []): string {
  if (kept.length > 0) return `I couldn't find ${attributes.join(" ")} ${things}. Here are the closest matches.`;
  return `I couldn't find ${attributes.join(" ")} ${things} in our catalog. Here are other ${things}.`;
}

/** Asked words the shown cards don't all have. */
export const droppedAttributes = (requested: Query, applied: Query): string[] =>
  requested.attributes.filter((a) => !applied.attributes.includes(a));

export function resultsSentence(group: Group, names: Names): string {
  const q = group.query;
  const n = group.products.length;
  const { total } = group;
  const purposeLine = purposeSentence(q, n, false);
  if (purposeLine !== null) return purposeLine;
  // A browse shows one product per category (retrieval "browse_diverse"), so say so.
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
  if (group.match === "attributes_relaxed" && group.query.noun === null && requested.noun !== null) {
    return `I couldn't find ${[...requested.attributes, plural(requested.noun)].join(" ")}. Here are other ${group.query.attributes.join(" ")} products.`;
  }
  if (group.match === "attributes_relaxed") return attributesRelaxed(requested.attributes, subject(group.query, names), group.query.attributes);
  if (group.match === "category_fallback" && group.query.category !== null) {
    const words = [...(requested.noun === null ? [] : [requested.noun]), ...requested.attributes];
    return categoryFallback(words, categoryName(group.query.category, names));
  }
  return resultsSentence(group, names);
}

export const droppedIntents = () => "I only looked up the first two.";
export const serviceMentioned = () => "I can't book travel or other services.";
export const currencyNotApplied = () => "Prices are in US dollars, so I didn't apply that price limit.";
export const currencyConverted = () => `Prices are in US dollars; I converted shekels at about ₪${ILS_PER_USD} to the dollar.`;
export const secondPatchIgnored = () => "I changed one thing; send the other change separately.";
export const couldNotLoad = (label: string) => `I couldn't load ${label} right now.`;

/** Template text for a product turn: one sentence per fetched group, then one append per flag. */
export function resultsText(views: GroupView[], flags: TurnFlags, names: Names): string {
  const sentences: string[] = [];
  for (const view of views) {
    const s = groupSentence(view, names);
    if (s !== null) sentences.push(s);
  }
  if (flags.droppedIntents) sentences.push(droppedIntents());
  if (flags.mentionsService) sentences.push(serviceMentioned());
  if (flags.currencyNotApplied) sentences.push(currencyNotApplied());
  if (flags.currencyConverted) sentences.push(currencyConverted());
  if (flags.secondPatchIgnored) sentences.push(secondPatchIgnored());
  for (const view of views) {
    if (view.group.status === "unavailable") sentences.push(couldNotLoad(view.group.label));
  }
  return sentences.join(" ");
}

export function clarify(why: "gift_budget" | "unknown_theme", ctx: PurposeContext): string {
  if (why === "unknown_theme") return "I'm not sure what fits that in our catalog. What kind of product are you after? Pick one below or tell me.";
  if (ctx.gender === null && !ctx.kid) return "Happy to help with a gift. Who is it for, and roughly what budget? Pick below or just tell me.";
  return "Happy to help with a gift. Roughly what budget, and what do they like? Pick below or just tell me.";
}

export const en: Templates = {
  greeting, service, offTopic, refusal, referNoCards, referUnclear, askWhichGroup, catalogOverview, referText, resultsText, clarify,
  more: (label, from, to, total) => (from === to ? `Here is ${label} ${from} of ${total}.` : `Here are ${label} ${from} to ${to} of ${total}.`),
  noMore: (label, total) => `That's all ${total} ${label} we have.`,
};

// ---------- Hebrew ----------
// Whole sentences, not English fragments: Hebrew word order and plural do not follow plural().
// Gender-neutral phrasing toward the user. Group labels ("Dresses") are catalog data and stay English.

const HE_HELP = "אני יכול לעזור לך למצוא מוצרים בקטלוג שלנו.";

function hePrice(q: Query): string {
  if (q.priceMin !== null && q.priceMax !== null) return ` בין ${money(q.priceMin)} ל-${money(q.priceMax)}`;
  if (q.priceMax !== null) return ` עד ${money(q.priceMax)}`;
  if (q.priceMin !== null) return ` מ-${money(q.priceMin)} ומעלה`;
  return "";
}

function heGroupSentence(view: GroupView, names: Names): string | null {
  const { group, requested, relative } = view;
  const label = group.label;
  if (group.status === "unavailable") return null;
  if (group.status === "miss") {
    if (relative?.direction === "cheaper") return `אין בחיפוש הזה משהו זול מ-${money(relative.price)}.`;
    if (relative?.direction === "pricier") return `אין בחיפוש הזה משהו יקר מ-${money(relative.price)}.`;
    const what = [...group.query.attributes, label].join(" ");
    const kept = view.keptPrevious ? " התוצאות הקודמות עדיין מוצגות למטה." : "";
    return `לא מצאתי בקטלוג "${what}"${hePrice(group.query)}${group.query.inStock ? " במלאי" : ""}.${kept}`;
  }
  if (group.match === "attributes_relaxed" && group.query.noun === null && requested.noun !== null) {
    return `לא מצאתי "${[...requested.attributes, requested.noun].join(" ")}". הנה מוצרים אחרים של ${group.query.attributes.join(" ")}.`;
  }
  if (group.match === "attributes_relaxed") {
    // Worded so nothing agrees with the label's gender: the label is Hebrew (שמלות) or English (Earphones).
    if (group.query.attributes.length > 0) return `אין התאמה מדויקת ל-"${requested.attributes.join(" ")}" בקטגוריה ${label}. אלה המוצרים הקרובים ביותר.`;
    return `אין התאמה ל-"${requested.attributes.join(" ")}" בקטגוריה ${label}. הנה מוצרים אחרים בקטגוריה.`;
  }
  if (group.match === "category_fallback" && group.query.category !== null) {
    const words = [...(requested.noun === null ? [] : [requested.noun]), ...requested.attributes].join(" ");
    return `לא מצאתי "${words}" בקטגוריה ${categoryName(group.query.category, names)}. הנה מוצרים אחרים בקטגוריה.`;
  }
  const q = group.query;
  const n = group.products.length;
  const purposeLine = purposeSentence(q, n, true);
  if (purposeLine !== null) return purposeLine;
  if (hasNoConstraint(q)) {
    const ask = "אפשר לציין קטגוריה או תקציב כדי לצמצם.";
    if (q.sort === "price_asc") return `הנה המוצרים הזולים ביותר מ-${n} קטגוריות שונות. ${ask}`;
    if (q.sort === "price_desc") return `הנה המוצרים היקרים ביותר מ-${n} קטגוריות שונות. ${ask}`;
    return `הנה ${n} מוצרים עם דירוג גבוה מקטגוריות שונות. ${ask}`;
  }
  const first = group.products[0];
  if (q.top && first !== undefined && group.total > 1 && q.sort !== "relevance") {
    const word = q.sort === "price_asc" ? "הזול ביותר" : q.sort === "price_desc" ? "היקר ביותר" : "המדורג ביותר";
    const next = n > 1 ? " אחריו מוצגים הבאים בתור." : "";
    return `${word} מבין ${group.total} התוצאות עבור ${label} הוא ${first.title} ב-${money(first.price)}.${next}`;
  }
  const head = n === 1 && group.total === 1 ? `הנה תוצאה אחת עבור ${label}`
    : n === group.total ? `הנה ${n} תוצאות עבור ${label}` : `הנה ${n} מתוך ${group.total} תוצאות עבור ${label}`;
  if (q.sort === "price_asc") return `${head}, מהזול ליקר.`;
  if (q.sort === "price_desc") return `${head}, מהיקר לזול.`;
  return `${head}.`;
}

export const he: Templates = {
  greeting: () => HE_HELP,
  service: () => "אני לא יכול להזמין נסיעות או שירותים אחרים, או לבדוק הזמנות ומשלוחים; בעניין הזמנה כדאי לפנות לשירות הלקוחות של החנות. אשמח לעזור למצוא מוצרים. אפשר לנסות:",
  offTopic: () => "זה מחוץ למה שאני יכול לעזור בו. אני מוצא מוצרים בקטלוג של החנות. אפשר לנסות:",
  refusal: () => `אני לא יכול לעזור בזה. ${HE_HELP}`,
  referNoCards: () => "עדיין אין מוצרים על המסך. מה לחפש?",
  referUnclear: (n) => `על איזה מוצר מדובר? אפשר לציין מספר בין 1 ל-${n} או את שם המוצר.`,
  askWhichGroup: (label1, label2) => `מה לשנות: ${label1} או ${label2}?`,
  more: (label, from, to, total) => (from === to ? `הנה ${label} ${from} מתוך ${total}.` : `הנה ${label} ${from} עד ${to} מתוך ${total}.`),
  noMore: (label, total) => `אלה כל ${total} התוצאות עבור ${label}.`,
  clarify: (why, ctx) => {
    if (why === "unknown_theme") return "לא בטוח מה הכי מתאים לזה בקטלוג שלנו. איזה סוג מוצר מחפשים? אפשר לבחור למטה או לכתוב.";
    if (ctx.gender === null && !ctx.kid) return "בשמחה אעזור עם מתנה. למי היא, ומה התקציב בערך? אפשר לבחור למטה או פשוט לכתוב.";
    return "בשמחה אעזור עם מתנה. מה התקציב בערך, ובמה להתמקד? אפשר לבחור למטה או פשוט לכתוב.";
  },
  catalogOverview: (names) =>
    names === null || names.length === 0
      ? `${HE_HELP} רשימת הקטגוריות לא זמינה כרגע.`
      : `${HE_HELP} הקטגוריות כוללות: ${names.map((c) => c.name).join(", ")}.`,
  referText: (title, unavailable) =>
    unavailable ? `הנה פרטים נוספים על ${title}. פרטים מלאים לא זמינים כרגע.` : `הנה פרטים נוספים על ${title}.`,
  resultsText(views, flags, names) {
    const sentences: string[] = [];
    for (const view of views) {
      const s = heGroupSentence(view, names);
      if (s !== null) sentences.push(s);
    }
    if (flags.droppedIntents) sentences.push("חיפשתי רק את שני הדברים הראשונים.");
    if (flags.mentionsService) sentences.push("אני לא יכול להזמין טיסות או שירותים אחרים.");
    if (flags.currencyNotApplied) sentences.push("המחירים בדולרים, לכן לא החלתי את מגבלת המחיר.");
    if (flags.currencyConverted) sentences.push(`המחירים בדולרים; המרתי משקלים לפי כ-${ILS_PER_USD} ₪ לדולר.`);
    if (flags.secondPatchIgnored) sentences.push("שיניתי דבר אחד; שלחו את השינוי השני בנפרד.");
    for (const view of views) {
      if (view.group.status === "unavailable") sentences.push(`לא הצלחתי לטעון את ${view.group.label} כרגע.`);
    }
    return sentences.join(" ");
  },
};

export const templatesFor = (lang: Lang): Templates => (lang === "he" ? he : en);
