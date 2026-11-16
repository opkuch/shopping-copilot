import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallCtx, RawProduct, RetrievalQuery } from "../src/pipeline/ports.ts";
import { CallFailed } from "../src/pipeline/ports.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { applyFilters, cap4, sortProducts, toCard } from "../src/retrieval/filter.ts";
import { normalizeWord, normalizeWords } from "../src/slots/normalize.ts";
import { resolveCategory } from "../src/slots/aliases.ts";
import { createFixtureApi } from "./fakes/catalog.ts";

function makeCtx() {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx: CallCtx = {
    budget: { remaining: () => 1e9, timeoutFor: (t) => t },
    trace: { event: (kind, data) => void events.push({ kind, data }) },
  };
  return { ctx, events };
}

const query = (o: Partial<RetrievalQuery> = {}): RetrievalQuery => ({
  category: null, noun: null, attributes: [], priceMin: null, priceMax: null,
  sort: "relevance", inStock: false, categoryStated: true, gender: null, top: false, within: null, purpose: null, offset: 0, ...o,
});
const titles = (r: { products: Array<{ title: string }> }) => r.products.map((p) => p.title);

test("filter, sort, then cap at 4 with total before the cap", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const r = await createRetriever(api).retrieve(query({ category: "mobile-accessories", sort: "price_asc", priceMax: 100 }), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.match, "exact");
  assert.equal(r.products.length, 4);
  const prices = r.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  const all = (await api.byCategory("mobile-accessories", ctx)).products.filter((p) => p.price <= 100);
  assert.equal(r.total, all.length);
  assert.ok(r.total > 4);
  assert.equal(cap4([1, 2, 3, 4, 5]).length, 4);
});

test("in-stock products rank before out-of-stock under every sort", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const retriever = createRetriever(api);
  const oos = (await api.all(ctx)).products.filter((p) => p.stock === 0);
  assert.equal(oos.length, 4);

  // motorcycle: Sportbike (id 117, stock 0) would be first or mid-pack by price/rating on its own
  const cases: Array<[Partial<RetrievalQuery>, number[]]> = [
    [{ sort: "price_asc", priceMin: 7000 }, [114, 115, 117]],
    [{ sort: "price_desc", priceMin: 2000, priceMax: 8000 }, [113, 116, 117]],
    [{ sort: "rating", priceMin: 7000 }, [114, 115, 117]],
  ];
  for (const [over, ids] of cases) {
    const r = await retriever.retrieve(query({ category: "motorcycle", ...over }), ctx);
    assert.deepEqual(r.products.map((p) => p.id), ids, JSON.stringify(over));
    assert.equal(r.products.at(-1)?.inStock, false);
  }
  // every category holding an out-of-stock product, under all four sorts
  for (const p of oos) {
    const rows = (await api.byCategory(p.category, ctx)).products;
    for (const sort of ["price_asc", "price_desc", "rating", "relevance"] as const) {
      const sorted = sortProducts(rows, sort, []);
      const firstOos = sorted.findIndex((x) => x.stock === 0);
      assert.ok(sorted.slice(firstOos).every((x) => x.stock === 0), `${p.category} ${sort}`);
    }
  }
  const stocked = await retriever.retrieve(query({ category: "motorcycle", priceMin: 7000, inStock: true }), ctx);
  assert.deepEqual(stocked.products.map((p) => p.id).sort(), [114, 115]);
});

test("sortProducts: relevance ranks title hits first and is stable; ties keep API order", () => {
  const mk = (id: number, title: string, description: string): RawProduct => ({
    id, title, description, price: 1, thumbnail: "", rating: 1, category: "x", stock: 5,
  });
  const rows = [mk(1, "Plain", "red leather"), mk(2, "Red Leather Bag", ""), mk(3, "Leather Case", "red"), mk(4, "Other", "red leather")];
  assert.deepEqual(sortProducts(rows, "relevance", ["red", "leather"]).map((p) => p.id), [2, 3, 1, 4]);
  const byRating = [mk(1, "a", ""), { ...mk(2, "b", ""), rating: 5 }];
  assert.deepEqual(sortProducts(byRating, "relevance", []).map((p) => p.id), [2, 1]);
});

test("applyFilters bounds are inclusive; toCard truncates on a word boundary", () => {
  const mk = (price: number, stock: number): RawProduct => ({
    id: price, title: "Red Thing", description: "d", price, thumbnail: "", rating: 1, category: "x", stock,
  });
  const out = applyFilters([mk(10, 1), mk(20, 1), mk(30, 0), mk(40, 1)], { words: ["red"], priceMin: 20, priceMax: 40, inStock: true });
  assert.deepEqual(out.map((p) => p.price), [20, 40]);

  const long = "word ".repeat(60).trim();
  const card = toCard({ ...mk(1, 0), description: long });
  assert.ok(card.description.length <= 160);
  assert.ok(card.description.endsWith("…"));
  assert.ok(!card.description.slice(0, -1).endsWith(" "));
  assert.ok(card.description.slice(0, -1).split(" ").every((w) => w === "word"));
  assert.equal(card.inStock, false);
  assert.equal(toCard({ ...mk(1, 3), description: "short" }).description, "short");
});

test("denylist words never reach a query", async () => {
  assert.deepEqual(normalizeWords(["cool", "Stylish", "gift", "leather"]), ["leather"]);
  assert.equal(normalizeWord("Cool"), null);
  assert.equal(normalizeWord("presents"), null);
});

test("search q is always one word", async () => {
  const api = createFixtureApi();
  const { ctx, events } = makeCtx();
  const retriever = createRetriever(api);
  const r = await retriever.retrieve(query({ category: null, noun: "red lipstick" }), ctx);
  assert.deepEqual(api.calls, [{ method: "all", arg: null }]);
  assert.equal(r.applied.noun, "lipstick");
  assert.ok(events.some((e) => e.kind === "noun_multiword"));
  for (const noun of ["lipstick", "charger", "watch", "zzzz"]) await retriever.retrieve(query({ noun }), ctx);
  for (const c of api.calls) if (c.method === "search") assert.doesNotMatch(String(c.arg), /\s/);
});

test("fake mirrors the measured phrase-search behavior", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  assert.equal((await api.search("red lipstick", ctx)).products.length, 1);
  assert.equal((await api.search("lipstick red", ctx)).products.length, 0);
  assert.ok((await api.search("ring", ctx)).products.length > 20, "substring noise");
  const select = (await api.byCategory("beauty", ctx)).products[0];
  assert.deepEqual(Object.keys(select ?? {}).sort(), ["brand", "category", "description", "discountPercentage", "id", "price", "rating", "stock", "tags", "thumbnail", "title"]);
});

test("synonyms drop the word, hints keep it", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const retriever = createRetriever(api);

  const syn = resolveCategory({ category: null, noun: "laptop", attributes: [], utterance: "laptops" });
  assert.equal(syn.noun, null);
  const rs = await retriever.retrieve(query({ ...syn, category: syn.category, attributes: syn.attributes }), ctx);
  assert.equal(rs.total, 5);

  const hint = resolveCategory({ category: null, noun: "headphone", attributes: [], utterance: "headphones" });
  assert.equal(hint.category, "mobile-accessories");
  assert.equal(hint.noun, "headphone");
  api.reset();
  const rh = await retriever.retrieve(query(hint), ctx);
  assert.deepEqual(api.calls, [{ method: "byCategory", arg: "mobile-accessories" }]);
  assert.ok(rh.products.length > 0);
  assert.ok(titles(rh).includes("Apple AirPods Max Silver"));
  assert.ok(!titles(rh).some((t) => /charger/i.test(t)));
});

test('"phone case" does not resolve to smartphones', async () => {
  const resolved = resolveCategory({ category: null, noun: "case", attributes: ["phone"], utterance: "phone case" });
  assert.equal(resolved.category, null);
  assert.equal(resolved.noun, "case");
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  await createRetriever(api).retrieve(query(resolved), ctx);
  assert.deepEqual(api.calls, [{ method: "all", arg: null }]);
});

// A noun outside a category is matched locally over the whole (cached) catalog, so the enrichment
// keywords count; DummyJSON's search is no longer called. A stated category still fetches only itself.
test("all() is called for any uncategorized query; a category alone fetches only that category", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const retriever = createRetriever(api);
  const others: Array<Partial<RetrievalQuery>> = [
    { category: "laptops" },
    { category: "laptops", attributes: ["red"], priceMax: 1 },
  ];
  for (const o of others) await retriever.retrieve(query(o), ctx);
  assert.equal(api.calls.filter((c) => c.method === "all").length, 0);
  for (const o of [{ noun: "charger" }, { noun: "zzzz" }]) await retriever.retrieve(query(o), ctx);
  assert.equal(api.calls.filter((c) => c.method === "all").length, 2);
  assert.equal(api.calls.filter((c) => c.method === "search").length, 0);
  api.reset();

  const r = await retriever.retrieve(query({ attributes: ["red"] }), ctx);
  assert.equal(api.calls.filter((c) => c.method === "all").length, 1);
  assert.ok(r.products.length > 0);
  assert.ok(r.products.every((p) => /red/i.test(p.title + p.description)));
  api.reset();
  await retriever.retrieve(query({ priceMax: 10 }), ctx);
  await retriever.retrieve(query({ inStock: true }), ctx);
  assert.equal(api.calls.filter((c) => c.method === "all").length, 2);
});

test("no category and no hits is a miss", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(query({ noun: "flight" }), ctx);
  assert.equal(r.status, "miss");
  assert.equal(r.match, "none");
  assert.deepEqual(r.products, []);
  assert.equal(r.total, 0);
});

test("inferred category with a noun the category lacks searches the whole catalog", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const r = await createRetriever(api).retrieve(
    query({ category: "smartphones", noun: "charger", categoryStated: false }), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.match, "noun_outside_category");
  assert.equal(r.applied.category, null);
  assert.equal(r.applied.noun, "charger");
  assert.ok(titles(r).includes("Apple iPhone Charger"));
  assert.deepEqual(api.calls.map((c) => c.method), ["byCategory", "all"]);
});

test("a guessed category and a noun missing everywhere is a miss, not a page of that category", async () => {
  // "stylus" guessed as smartphones must not show phones: the noun is the product type the user asked for.
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    query({ category: "smartphones", noun: "stylus", categoryStated: false }), ctx);
  assert.equal(r.status, "miss");
});

test("attributes are soft: no white dress exists, so other dresses are shown with the noun kept", async () => {
  const api = createFixtureApi();
  const { ctx, events } = makeCtx();
  const r = await createRetriever(api).retrieve(query({ noun: "dress", attributes: ["white"], categoryStated: false }), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.match, "attributes_relaxed");
  assert.equal(r.applied.noun, "dress");
  assert.deepEqual(r.applied.attributes, []);
  assert.equal(r.total, 10);
  assert.ok(events.some((e) => e.kind === "retrieval" && e.data.row === "attributes_relaxed"));
  // the whole catalog, matched locally: the categories that ARE dresses count through nounCategories
  assert.deepEqual(api.calls.map((c) => `${c.method}:${c.arg}`), ["all:null"]);
});

test("a noun matches by category as well as by word: all 5 womens-dresses are dresses", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    query({ category: "womens-dresses", noun: "dress", categoryStated: false }), ctx);
  assert.equal(r.match, "exact");
  assert.equal(r.total, 5);
});

test("gender chooses the category and is not matched as text", async () => {
  const { ctx } = makeCtx();
  const retriever = createRetriever(createFixtureApi());
  const men = await retriever.retrieve(query({ noun: "watch", gender: "mens", categoryStated: false }), ctx);
  assert.equal(men.match, "exact");
  assert.ok(men.products.length > 0 && men.products.every((p) => !p.category.startsWith("womens-")));
  const women = await retriever.retrieve(query({ noun: "shoe", gender: "womens", categoryStated: false }), ctx);
  assert.ok(women.products.length > 0 && women.products.every((p) => !p.category.startsWith("mens-")));
  assert.equal(normalizeWord("men's"), "men");
  assert.equal(normalizeWord("Women’s"), "women");
});

test("gender survives attribute relaxation: no black running shoes for men never shows women's shoes", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    query({ noun: "shoe", attributes: ["running", "black"], gender: "mens", categoryStated: false }), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.applied.gender, "mens");
  assert.ok(r.products.every((p) => p.category === "mens-shoes"), titles(r).join(", "));
});

test("a gender alone is a browse over that gender's side of the catalog", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(query({ gender: "womens", sort: "rating" }), ctx);
  assert.equal(r.status, "results");
  assert.equal(new Set(r.products.map((p) => p.category)).size, r.products.length, "one card per category");
  assert.ok(r.products.every((p) => !p.category.startsWith("mens-")));
});

test("a brand word means the brand: apple finds Apple products, not the fruit", async () => {
  const { ctx } = makeCtx();
  const retriever = createRetriever(createFixtureApi());
  const all = await retriever.retrieve(query({ attributes: ["apple"] }), ctx);
  assert.equal(all.status, "results");
  assert.ok(all.total >= 10, `total ${all.total}`);
  assert.ok(all.products.every((p) => p.category !== "groceries"), titles(all).join(", "));
  const phones = await retriever.retrieve(query({ category: "smartphones", attributes: ["apple"] }), ctx);
  assert.equal(phones.match, "exact");
  assert.ok(titles(phones).every((t) => /iphone/i.test(t)), titles(phones).join(", "));
});

test("tags count for the noun: earrings and over-ear headphones are found by what they are", async () => {
  const { ctx } = makeCtx();
  const retriever = createRetriever(createFixtureApi());
  const earrings = await retriever.retrieve(query({ noun: "earring", categoryStated: false }), ctx);
  assert.equal(earrings.total, 3);
  const necklace = await retriever.retrieve(query({ noun: "necklace", categoryStated: false }), ctx);
  assert.equal(necklace.status, "miss", "earrings are not necklaces");
});

test("the noun is matched on title and tags, not description: water is not a Rolex", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(query({ noun: "water", categoryStated: false }), ctx);
  assert.ok(r.products.length > 0);
  assert.ok(r.products.every((p) => !/rolex/i.test(p.title)), titles(r).join(", "));
});

test("a noun naming the category itself resolves to the category: skin care with an unmatched attribute", async () => {
  const resolved = resolveCategory({ category: "skin-care", noun: "skin care", attributes: ["dry"], utterance: "I need skincare for dry skin" });
  assert.equal(resolved.noun, null);
  assert.equal(resolved.categoryStated, true);
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(query(resolved), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.match, "category_fallback");
  assert.equal(r.total, 3);
});

test("a stated category is never relaxed away: red laptops under $1 is still a miss", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    query({ category: "laptops", noun: "laptop", attributes: ["red"], priceMax: 1 }), ctx);
  assert.equal(r.status, "miss");
});

test("stated category emptied by an attribute falls back inside the category without searching", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const r = await createRetriever(api).retrieve(
    query({ category: "laptops", attributes: ["red"], categoryStated: true, sort: "price_asc" }), ctx);
  assert.equal(r.status, "results");
  assert.equal(r.match, "category_fallback");
  assert.equal(r.applied.category, "laptops");
  assert.deepEqual(r.applied.attributes, []);
  assert.ok(r.products.every((p) => p.category === "laptops"));
  const prices = r.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(!api.calls.some((c) => c.method === "search"));
});

test("category fallback keeps the price bound; nothing under it is a miss", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(query({ category: "laptops", priceMax: 1 }), ctx);
  assert.equal(r.status, "miss");
  assert.equal(r.applied.priceMax, 1);
  const withWord = await createRetriever(createFixtureApi()).retrieve(
    query({ category: "laptops", attributes: ["red"], priceMax: 1 }), ctx);
  assert.equal(withWord.status, "miss");
});

test("inferred category, noun not found anywhere, and nothing passes price is a miss", async () => {
  const { ctx } = makeCtx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    query({ category: "smartphones", noun: "zzzz", priceMax: 1, categoryStated: false }), ctx);
  assert.equal(r.status, "miss");
});

test("a browse (sort only) shows one product per category, in stock first, cap 4", async () => {
  const api = createFixtureApi();
  const { ctx } = makeCtx();
  const r = await createRetriever(api).retrieve(query({ sort: "price_asc" }), ctx);
  assert.deepEqual(api.calls.map((c) => c.method), ["all"]);
  assert.equal(r.products.length, 4);
  // groceries, vehicles and motorcycles are not browsed: 194 minus 37
  assert.equal(r.total, 157);
  assert.ok(r.products.every((p) => !["groceries", "vehicle", "motorcycle"].includes(p.category)));
  assert.ok(r.products.every((p) => p.inStock));
  assert.equal(new Set(r.products.map((p) => p.category)).size, 4, "not four groceries");
  const prices = r.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  api.reset();
  const rated = await createRetriever(api).retrieve(query({ sort: "relevance" }), ctx);
  assert.deepEqual(api.calls.map((c) => c.method), ["all"]);
  assert.equal(rated.match, "exact");
  assert.equal(new Set(rated.products.map((p) => p.category)).size, 4);
});

test("api failures propagate as CallFailed", async () => {
  const api = createFixtureApi();
  api.failNext.byCategory = new CallFailed("network", "down");
  const { ctx } = makeCtx();
  await assert.rejects(createRetriever(api).retrieve(query({ category: "laptops" }), ctx), CallFailed);
  // failNext is consumed once
  assert.equal((await createRetriever(api).retrieve(query({ category: "laptops" }), ctx)).status, "results");
});

