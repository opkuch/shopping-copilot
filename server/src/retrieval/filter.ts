import type { RawProduct } from "../pipeline/ports.ts";
import type { Gender, ProductCard, Sort } from "../messages/schema.ts";
import { brandKey, matchedWords, matchesAll, matchesNoun, productGender, titleHits } from "./match.ts";

export type FilterSpec = {
  /** Words that must all appear in title, description, or tags; a word that is a brand must be the brand. */
  words: string[];
  /** The product type: matched by word or by category (see nouns.ts). Omitted: no noun constraint. */
  noun?: string | null;
  nounCategories?: readonly string[];
  /** Products in categories with this prefix are out ("womens-" for a men's request). */
  excludeCategoryPrefix?: string | null;
  /** Products made for the other gender are out, in any category (a women's perfume for "perfume for men"). */
  gender?: Gender | null;
  /** Brands or words ruled out ("not Chanel"): a product with any of them, as its brand or in its text, is out. */
  exclude?: string[];
  priceMin: number | null;
  priceMax: number | null;
  inStock: boolean;
};

export function applyFilters(products: RawProduct[], q: FilterSpec): RawProduct[] {
  // A word that is some candidate's whole brand ("apple", "calvin klein") means that brand, not the
  // word in text: "apple products" must find the iPhones, not the Green Apple in groceries.
  const brands = new Set(products.map(brandKey).filter((b): b is string => b !== null));
  const brandWords = q.words.filter((w) => brands.has(w));
  const textWords = q.words.filter((w) => !brands.has(w));
  return products.filter(
    (p) =>
      (q.priceMin === null || p.price >= q.priceMin) &&
      (q.priceMax === null || p.price <= q.priceMax) &&
      (!q.inStock || p.stock > 0) &&
      !(q.excludeCategoryPrefix && p.category.startsWith(q.excludeCategoryPrefix)) &&
      !(q.gender && productGender(p) !== null && productGender(p) !== q.gender) &&
      matchesNoun(p, q.noun ?? null, q.nounCategories ?? []) &&
      brandWords.every((w) => brandKey(p) === w) &&
      matchesAll(p, textWords) &&
      !(q.exclude ?? []).some((w) => brandKey(p) === w || matchedWords(p, [w]).length > 0),
  );
}

/**
 * A browse ("something cheap", "gift ideas"): round-robin over categories in sorted order, the best of
 * each category first, then the second best of each, so four cards show four kinds of thing when there
 * are four, and a one-category set still fills the row.
 */
export function spread(sorted: RawProduct[]): RawProduct[] {
  const byCategory = new Map<string, RawProduct[]>();
  for (const p of sorted) {
    const list = byCategory.get(p.category);
    if (list) list.push(p);
    else byCategory.set(p.category, [p]);
  }
  const lists = [...byCategory.values()];
  const out: RawProduct[] = [];
  for (let round = 0; out.length < sorted.length; round++) {
    for (const list of lists) if (list[round] !== undefined) out.push(list[round] as RawProduct);
  }
  return out;
}

// Array.prototype.sort is stable, so ties keep the order DummyJSON returned. In-stock is the
// first key under every sort so out-of-stock products only fill slots when nothing else can.
// "relevance" means the shopper asked for no order: the words they used count first (title hits), then
// the rating, so the best-reviewed products lead.
export function sortProducts(products: RawProduct[], sort: Sort, words: string[]): RawProduct[] {
  const hits = new Map<number, number>();
  if (sort === "relevance") for (const p of products) hits.set(p.id, titleHits(p, words));
  const secondary = (a: RawProduct, b: RawProduct): number => {
    switch (sort) {
      case "price_asc": return a.price - b.price;
      case "price_desc": return b.price - a.price;
      case "rating": return b.rating - a.rating;
      case "relevance":
        return (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0) || b.rating - a.rating;
    }
  };
  return [...products].sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || secondary(a, b));
}

const CARD_DESCRIPTION_MAX = 160;
/** "Only 3 left" from this many units down. */
const LOW_STOCK = 5;

function truncate(text: string): string {
  if (text.length <= CARD_DESCRIPTION_MAX) return text;
  // leave room for the ellipsis so the whole string stays within the limit
  let cut = text.slice(0, CARD_DESCRIPTION_MAX - 1);
  if (text[CARD_DESCRIPTION_MAX - 1] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

export function toCard(raw: RawProduct): ProductCard {
  return {
    id: raw.id,
    title: raw.title,
    description: truncate(raw.description),
    price: raw.price,
    thumbnail: raw.thumbnail,
    rating: raw.rating,
    category: raw.category,
    inStock: raw.stock > 0,
    brand: raw.brand ?? null,
    discountPercentage: raw.discountPercentage === undefined ? null : Math.round(raw.discountPercentage),
    stockLeft: raw.stock > 0 && raw.stock <= LOW_STOCK ? raw.stock : null,
  };
}

export function firstPage<T>(items: T[], size = 4): T[] {
  return items.slice(0, size);
}
