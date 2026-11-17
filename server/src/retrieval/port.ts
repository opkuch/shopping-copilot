import type { Query } from "../messages/schema.ts";
import type { CallCtx, CatalogApi, RawProduct, RetrievalResult, RetrieveOptions, Retriever } from "../pipeline/ports.ts";
import { applyFilters, firstPage, sortProducts, spread, toCard } from "./filter.ts";
import type { FilterSpec } from "./filter.ts";
import { brandKey, matchedWords } from "./match.ts";
import { excludedPrefix, nounCategories } from "./nouns.ts";

const NOT_BROWSED = new Set(["groceries", "vehicle", "motorcycle"]);
/** A gift with a budget leads with products costing at least this share of it. */
const GIFT_BUDGET_FLOOR = 0.25;
/** A vague request ("surprise me", "something cheap and cool") is a recommendation: well-reviewed products only. */
const RECOMMEND_MIN_RATING = 4;
/** A browse with no budget is a shop window, not a showroom: "a gift for my dad" doesn't lead with a $9,000 Rolex. */
const BROWSE_DEFAULT_MAX = 1000;

/*
 * Constraints are hard or soft:
 * - hard, never relaxed: price bounds, in stock, gender, exclusions, the product type (noun or category), a brand;
 * - soft: the other words (color, material), dropped when nothing has them all, and the reply says which.
 * So there are two steps: an exact match, then the same product type with the most of the soft words kept.
 * Anything else is an honest miss with chips (pipeline/purpose.ts). Measured on the eval traces: further
 * fallbacks (the noun outside a guessed category, the brand without the noun, other products in the category)
 * produced cards 2 times in 125 attempts.
 */
export function createRetriever(api: CatalogApi): Retriever {
  return {
    async retrieve(query, ctx, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
      const { noun, leading } = headNoun(query.noun, ctx);
      const nounCats = nounCategories(noun, query.gender);
      // "golf ball": the head is the noun, "golf" narrows it like any attribute.
      const words = [...new Set([...leading, ...query.attributes])];
      const applied: Query = { ...query, noun, attributes: words };
      const rankWords = [...new Set([...(noun === null ? [] : [noun]), ...words])];
      const strict: FilterSpec = {
        words, noun, nounCategories: nounCats, excludeCategoryPrefix: excludedPrefix(query.gender), gender: query.gender,
        exclude: query.exclude, priceMin: query.priceMin, priceMax: query.priceMax, inStock: query.inStock,
      };
      const trace = (row: string, extra: Record<string, unknown> = {}) =>
        ctx.trace.event("retrieval", {
          row, words: rankWords, nounCategories: nounCats, category: query.category, gender: query.gender,
          price: [query.priceMin, query.priceMax], sort: query.sort, exclude: query.exclude, ...extra,
        });

      // "Show more" pages through the same sorted rows; the steps are deterministic, so page 2 follows page 1.
      const show = (rows: RawProduct[]) => firstPage(rows.slice(query.offset), opts.pageSize);
      const hit = (match: RetrievalResult["match"], rows: RawProduct[], a: Query): RetrievalResult => ({
        status: "results", match, products: show(rows).map(toCard), total: rows.length, applied: a,
      });
      const miss = (): RetrievalResult => ({ status: "miss", match: "none", products: [], total: 0, applied });
      const finish = (rows: RawProduct[], f: FilterSpec, rank: string[]) => sortProducts(applyFilters(rows, f), query.sort, rank);

      // Browse: no category, product, or words ("something cheap", "gift ideas for him under $100"). Cards are
      // spread across categories so four cards show four kinds of thing. `within` (pipeline/purpose.ts) limits
      // the categories; without it, groceries, cars and motorcycles are left out.
      if (query.category === null && noun === null && words.length === 0) {
        const all = (await api.all(ctx)).products;
        const inSet = query.within !== null
          ? all.filter((p) => (query.within as string[]).includes(p.category))
          : all.filter((p) => !NOT_BROWSED.has(p.category));
        const noBudget = query.priceMin === null && query.priceMax === null;
        let allowed = applyFilters(inSet, { ...strict, words: [], noun: null, nounCategories: [], priceMax: noBudget ? BROWSE_DEFAULT_MAX : query.priceMax });
        // A recommendation keeps to products rated 4 or more, unless that leaves too few to fill the row:
        // otherwise the cheapest picks were a 3.1-star fork and a 2.9-star shuttlecock.
        if (query.purpose === "curated") {
          const good = allowed.filter((p) => p.rating >= RECOMMEND_MIN_RATING);
          if (good.length >= 4) allowed = good;
        }
        // A gift with a budget: products that use it (a quarter of it or more) first, still by rating within,
        // then the cheaper ones, so "up to $200" doesn't lead with a $12.99 lunch box.
        let sorted = sortProducts(allowed, query.sort, []);
        if (query.purpose === "gift" && query.priceMax !== null) {
          const floor = query.priceMax * GIFT_BUDGET_FLOOR;
          sorted = [...sorted.filter((p) => p.price >= floor), ...sorted.filter((p) => p.price < floor)];
        }
        const rows = spread(sorted);
        trace("browse", { fetched: all.length, within: query.within, categories: new Set(rows.map((p) => p.category)).size });
        return rows.length === 0 ? miss() : { ...hit("exact", rows, query), total: allowed.length };
      }

      // Candidates: the category's products when one is known, else the whole catalog (one cached call).
      // DummyJSON's own search matches `q` as one phrase of its text, so it could never find Juice for
      // "drink" or the Beats earphones for "headphone"; matching here lets the enrichment keywords count.
      const candidates = query.category !== null
        ? (await api.byCategory(query.category, ctx)).products
        : (await api.all(ctx)).products;

      // 1. Exact.
      const exact = finish(candidates, strict, rankWords);
      trace(query.category !== null ? "category" : "catalog", { fetched: candidates.length, matched: exact.length });
      if (exact.length > 0) return hit("exact", exact, applied);
      // "Cheaper" is the same search at another price: nothing cheaper is the answer, not a relaxed search
      // that quietly drops "white" to find a cheaper shoe.
      if (opts.exactOnly || words.length === 0 || (noun === null && query.category === null)) return miss();

      // 2. The same product type, with the most of the soft words kept: "black leather handbag" shows the black
      // handbag and the leather bag, not every bag. A brand among the words is never the one dropped: "red
      // Samsung phone" must not become a red Oppo.
      const brands = new Set(candidates.map(brandKey).filter((b): b is string => b !== null));
      const kept = words.filter((w) => brands.has(w));
      const soft = words.filter((w) => !brands.has(w));
      const pool = finish(candidates, { ...strict, words: kept }, rankWords);
      const partial = bestPartial(pool, soft);
      const dropped = soft.filter((w) => !partial.kept.includes(w));
      trace("attributes_relaxed", { dropped, matched: partial.rows.length });
      if (partial.rows.length === 0) return miss();
      return { ...hit("attributes_relaxed", partial.rows, { ...applied, attributes: [...kept, ...partial.kept] }), dropped };
    },
  };
}

/**
 * The products that match the most of `words` (at least one), in their sorted order, and the words
 * every one of them has ("black leather": the black bag and the leather bag each keep one, so none is
 * kept by all). None matching any word: all of `sorted`, with nothing kept and best 0.
 */
export function bestPartial(sorted: RawProduct[], words: string[]): { rows: RawProduct[]; kept: string[]; best: number } {
  const hits = sorted.map((p) => matchedWords(p, words));
  const best = Math.max(0, ...hits.map((h) => h.length));
  if (best === 0) return { rows: sorted, kept: [], best };
  const rows = sorted.filter((_, i) => (hits[i] as string[]).length === best);
  const sets = hits.filter((h) => h.length === best);
  const kept = words.filter((w) => sets.every((h) => h.includes(w)));
  return { rows, kept, best };
}

// A product type is one word: "golf ball" is the noun "ball" narrowed by "golf". Before, the leading words
// were thrown away and "golf balls" showed baseball and tennis balls.
function headNoun(noun: string | null, ctx: CallCtx): { noun: string | null; leading: string[] } {
  if (noun === null) return { noun: null, leading: [] };
  const parts = noun.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { noun: parts[0] ?? null, leading: [] };
  const last = parts[parts.length - 1] as string;
  ctx.trace.event("noun_multiword", { noun, used: last, leading: parts.slice(0, -1) });
  return { noun: last, leading: parts.slice(0, -1) };
}
