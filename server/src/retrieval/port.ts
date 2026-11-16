import type { Query } from "../messages/schema.ts";
import type {
  CallCtx, CatalogApi, RawProduct, RetrievalQuery, RetrievalResult, RetrieveOptions, Retriever,
} from "../pipeline/ports.ts";
import { applyFilters, cap4, sortProducts, spread, toCard } from "./filter.ts";
import type { FilterSpec } from "./filter.ts";
import { brandKey, matchedWords } from "./match.ts";
import { excludedPrefix, nounCategories } from "./nouns.ts";

const NOT_BROWSED = new Set(["groceries", "vehicle", "motorcycle"]);
/** A gift with a budget leads with products costing at least this share of it. */
const GIFT_BUDGET_FLOOR = 0.25;
/** A vague request ("surprise me", "something cheap and cool") is a recommendation: well-reviewed products only. */
const RECOMMEND_MIN_RATING = 4;

/*
 * The empty-result ladder. Constraints are hard or soft:
 * - hard, never relaxed: price bounds, in stock, a category the user stated;
 * - semi-hard: the noun (the product type), satisfied by word or by category;
 * - soft: attributes (color, material, size words), dropped first, and the reply says so.
 * Steps, first hit wins: exact -> a full product name -> noun outside a guessed category ->
 * some attributes kept -> the brand without the noun -> noun only -> category fallback
 * (only for a stated category or no noun) -> miss.
 */
export function createRetriever(api: CatalogApi): Retriever {
  async function ladder(input: RetrievalQuery, ctx: CallCtx, opts: RetrieveOptions): Promise<RetrievalResult> {
    const mayDropNoun = opts.mayDropNoun ?? true;
    const query = input;
    const { noun, leading } = headNoun(query.noun, ctx);
    const nounCats = nounCategories(noun, query.gender);
    // Gender rules out the other gender's categories (nouns.ts); it is never text to match, and
    // it is a hard constraint: no step of the ladder below drops it.
    const excluded = excludedPrefix(query.gender);
    // "golf ball": the head is the noun, "golf" narrows it like any attribute.
    const textAttrs = [...new Set([...leading, ...query.attributes])];
    const applied: Query = { ...query, noun, attributes: textAttrs };
    const rankWords = [...new Set([...(noun === null ? [] : [noun]), ...textAttrs])];
    const strict: FilterSpec = {
      words: textAttrs, noun, nounCategories: nounCats, excludeCategoryPrefix: excluded, gender: query.gender,
      priceMin: query.priceMin, priceMax: query.priceMax, inStock: query.inStock,
    };
    const trace = (row: string, extra: Record<string, unknown> = {}) =>
      ctx.trace.event("retrieval", {
        row, words: rankWords, nounCategories: nounCats, category: query.category, stated: query.categoryStated,
        gender: query.gender, price: [query.priceMin, query.priceMax], sort: query.sort, ...extra,
      });

    // "Show more" pages through the same sorted rows; the ladder is deterministic, so page 2 follows page 1.
    const show = (rows: RawProduct[]) => cap4(rows.slice(query.offset));
    const miss = (): RetrievalResult => ({ status: "miss", match: "none", products: [], total: 0, applied });
    const hit = (match: RetrievalResult["match"], rows: RawProduct[], a: Query): RetrievalResult => ({
      status: "results", match, products: show(rows).map(toCard), total: rows.length, applied: a,
    });
    const finish = (rows: RawProduct[], f: FilterSpec, words: string[]) =>
      sortProducts(applyFilters(rows, f), query.sort, words);

    // Browse: no category, product, or words ("something cheap", "gift ideas for him under $100").
    // Cards are spread across categories so four cards show four kinds of
    // thing. `within` (pipeline/purpose.ts) limits the categories; without it, groceries, cars and
    // motorcycles are left out: a browse is a shop window, and a lemon or a $25,000 car is not one.
    const browse = query.category === null && noun === null && query.attributes.length === 0;
    if (browse) {
      const all = await api.all(ctx);
      const inSet = query.within !== null
        ? all.products.filter((p) => (query.within as string[]).includes(p.category))
        : all.products.filter((p) => !NOT_BROWSED.has(p.category));
      let allowed = applyFilters(inSet, { ...strict, words: [], noun: null, nounCategories: [] });
      // A recommendation ("something cheap and cool") keeps to products rated 4 or more, unless that leaves
      // too few to fill the row: otherwise the cheapest picks were a 3.1-star fork and a 2.9-star shuttlecock.
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
      trace("browse_diverse", { fetched: all.products.length, within: query.within, categories: new Set(rows.map((p) => p.category)).size });
      if (rows.length === 0) return miss();
      return { status: "results", match: "exact", products: show(rows).map(toCard), total: allowed.length, applied: query };
    }

    // Candidate set: the narrowest fetch the API can express.
    let row: string;
    let candidates: RawProduct[];
    if (query.category !== null) {
      row = "category";
      candidates = (await api.byCategory(query.category, ctx)).products;
    } else if (noun !== null) {
      // A noun outside any category: the whole catalog (one cached call), matched here by noun. DummyJSON's
      // own search matches `q` as one phrase of its text, so it could never find Juice for "drink" or the
      // Beats earphones for "headphone"; matching locally lets the enrichment keywords count.
      row = "noun";
      candidates = (await api.all(ctx)).products;
    } else {
      row = "all";
      candidates = (await api.all(ctx)).products;
    }

    // 1. Exact.
    const exact = finish(candidates, strict, rankWords);
    trace(row, { fetched: candidates.length, matched: exact.length });
    if (exact.length > 0) return hit("exact", exact, applied);
    // "Cheaper" is the same search at another price: nothing cheaper is the answer, not a relaxed search
    // that quietly drops "white" to find a cheaper shoe.
    if (opts.exactOnly) return miss();

    // 1b. A product named in full ("Nike Air Jordan") with a noun the extractor added ("sneaker") that the
    // product's own text doesn't use: the name is the stronger evidence.
    if (noun !== null && textAttrs.some((w) => w.includes(" "))) {
      const named = finish((await api.all(ctx)).products, { ...strict, noun: null, nounCategories: [] }, rankWords);
      trace("named_product", { matched: named.length });
      if (named.length > 0) return hit("exact", named, { ...applied, category: null, categoryStated: false });
    }

    // 2. A guessed category emptied by the user's noun: the noun wins, look for it everywhere.
    let wide: RawProduct[] = [];
    if (query.category !== null && !input.categoryStated && noun !== null) {
      wide = (await api.all(ctx)).products;
      const wideRows = finish(wide, strict, rankWords);
      trace("noun_outside_category", { fetched: wide.length, matched: wideRows.length });
      if (wideRows.length > 0) return hit("noun_outside_category", wideRows, { ...applied, category: null, categoryStated: false });
    }

    let brandWords: string[] | null = null;
    const brandsNamed = (): string[] => {
      if (brandWords !== null) return brandWords;
      // The brands of the products already fetched: a brand that none of them has cannot be kept anyway.
      const brands = new Set([...candidates, ...wide].map(brandKey).filter((b): b is string => b !== null));
      brandWords = textAttrs.filter((w) => brands.has(w));
      return brandWords;
    };

    // 3. Keep the product type and the most of the soft words: "black leather handbag" shows the black
    // handbag and the leather bag, not every bag. The words the shown cards don't all share are dropped.
    const relaxed: FilterSpec = { ...strict, words: [] };
    // No noun but a category ("black leather handbag": the handbag became the category): its products.
    const inCandidates = noun !== null ? finish(candidates, relaxed, [noun])
      : query.category !== null ? finish(candidates, relaxed, []) : [];
    const inCategory = inCandidates.length > 0;
    const pool = inCategory ? inCandidates : noun === null ? [] : finish(wide, relaxed, [noun]);
    // A brand among the words is never the one dropped: "red Samsung phone" must not become a red Oppo.
    const brands = textAttrs.length > 0 ? brandsNamed() : [];
    const branded = brands.length === 0 ? pool : applyFilters(pool, { ...relaxed, words: brands });
    const partial = textAttrs.length > 0 ? bestPartial(branded, textAttrs) : { rows: [], kept: [], best: 0 };
    const relaxedTo = (rows: RawProduct[], kept: string[]) => {
      trace("attributes_relaxed", { dropped: textAttrs.filter((w) => !kept.includes(w)), matched: rows.length });
      return hit("attributes_relaxed", rows, {
        ...applied, attributes: kept,
        category: inCategory ? query.category : null,
        categoryStated: inCategory && query.categoryStated,
      });
    };
    if (partial.best > 0 && partial.best > brands.length) return relaxedTo(partial.rows, partial.kept);

    // 4. A brand outranks the noun: no Nike sneaker, so Nike's other shoes, not a Puma. The brand is what
    // the user is loyal to; the noun is often the extractor's paraphrase ("sneaker" for "Air Jordan").
    if (noun !== null && textAttrs.length > 0) {
      const named = brandsNamed();
      if (named.length > 0) {
        const space = query.category !== null ? candidates : (await api.all(ctx)).products;
        const sameBrand = finish(space, { ...strict, noun: null, nounCategories: [], words: named }, named);
        trace("brand_kept", { brands: named, matched: sameBrand.length });
        if (sameBrand.length > 0) return hit("attributes_relaxed", sameBrand, { ...applied, noun: null, attributes: named });
      }
    }

    // 5. Keep the product type, drop every soft word ("white", "silk", "XL") that no product has.
    if (noun !== null && textAttrs.length > 0 && pool.length > 0) return relaxedTo(pool, []);

    // 6. Other products in a category the user named (or no noun to honor). Not for a guessed
    // category with a noun: "stylus" guessed as smartphones should not show phones.
    const nounMayGo = noun === null || (input.categoryStated && mayDropNoun);
    if (query.category !== null && nounMayGo && candidates.length > 0) {
      // A brand is never dropped: "Apple tablet under $400" with none is a miss, not a Samsung tablet.
      const keptBrands = brandsNamed();
      const fallback = finish(candidates, { ...strict, words: keptBrands, noun: null, nounCategories: [] }, []);
      trace("category_fallback", { matched: fallback.length });
      if (fallback.length > 0) return hit("category_fallback", fallback, { ...applied, noun: null, attributes: keptBrands });
    }

    return miss();
  }

  return {
    async retrieve(input, ctx, opts = {}) {
      const result = await ladder(input, ctx, opts);
      // A recipient carried over from context, not said in this message, never empties a search: after "a
      // gift for my dad", "I need a dress for myself" must not become "no men's dresses". A recipient the
      // user states stays a hard constraint.
      if (result.status === "miss" && opts.genderInherited === true && input.gender !== null) {
        ctx.trace.event("retrieval", { row: "inherited_gender_dropped", gender: input.gender });
        return ladder({ ...input, gender: null }, ctx, opts);
      }
      return result;
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
  const leading = parts.slice(0, -1);
  ctx.trace.event("noun_multiword", { noun, used: last, leading });
  return { noun: last, leading };
}
