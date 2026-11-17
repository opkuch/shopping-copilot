// Retrieval rules, each from a failure seen in testing: compounds, generic nouns, superlatives, prices, exclusions, partial attributes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtractedIntent } from "../src/messages/schema.ts";
import { approximate, asksForTop, foldCompound, intentToQuery, patchQuery, superlativeSort } from "../src/pipeline/merge.ts";
import type { RawProduct } from "../src/pipeline/ports.ts";
import { bestPartial } from "../src/retrieval/port.ts";
import { matchesAll } from "../src/retrieval/match.ts";
import { singularize } from "../src/slots/normalize.ts";

const intent = (o: Partial<ExtractedIntent> = {}): ExtractedIntent => ({
  category: null, noun: null, attributes: null, priceMin: null, priceMax: null, currency: null,
  relativePrice: null, sort: null, inStock: null, clear: [], exclude: null, gift: null, ...o,
});

const product = (id: number, title: string, description = "", tags: string[] = []): RawProduct =>
  ({ id, title, description, tags, price: 10, rating: 4, stock: 5, category: "x", thumbnail: "" }) as RawProduct;

test("-is and -us words are not plurals", () => {
  assert.equal(singularize("tennis"), "tennis");
  assert.equal(singularize("cactus"), "cactus");
  assert.equal(singularize("balls"), "ball");
});

test("a compound attribute ending with the noun becomes the noun", () => {
  assert.deepEqual(foldCompound("ball", ["basketball", "orange"]), { noun: "basketball", attributes: ["orange"] });
  assert.deepEqual(foldCompound("shoe", ["running"]), { noun: "shoe", attributes: ["running"] });
  // too short to be a compound: "a ball" with attribute "ball" stays as it is
  assert.deepEqual(foldCompound("ball", ["ball"]), { noun: "ball", attributes: ["ball"] });
});

test("a generic noun is no noun: 'tennis gear' searches tennis", () => {
  const { query } = intentToQuery(intent({ noun: "gear", attributes: ["tennis"] }), "cheap tennis gear");
  assert.equal(query.noun, null);
  assert.deepEqual(query.attributes, ["tennis"]);
});

test("singular superlatives ask for the top product; plural ones do not", () => {
  assert.equal(asksForTop("the most expensive men's Rolex"), true);
  assert.equal(asksForTop("the cheapest Samsung"), true);
  assert.equal(asksForTop("which bag is the best rated?"), true);
  assert.equal(asksForTop("the cheapest phones"), false);
  assert.equal(asksForTop("what are the cheapest headphones?"), false);
  assert.equal(asksForTop("cheap phones"), false);
});

test("a refine without a superlative is a list again", () => {
  const first = intentToQuery(intent({ noun: "phone", sort: "price_asc" }), "the cheapest phone").query;
  assert.equal(first.top, true);
  const next = patchQuery(first, intent({ priceMax: 500, currency: "USD" }), "under 500", []).query;
  assert.equal(next.top, false);
});

test("prices are dollars; a bound in another currency is not applied, and the reply says so", () => {
  const eur = intentToQuery(intent({ noun: "phone", priceMax: 1000, currency: "other" }), "phone under 1000 euros");
  assert.equal(eur.query.priceMax, null);
  assert.equal(eur.currencyNotApplied, true);
  const usd = intentToQuery(intent({ noun: "phone", priceMax: 1000, currency: "USD" }), "phone under 1000");
  assert.equal(usd.query.priceMax, 1000);
  assert.equal(usd.currencyNotApplied, false);
});

test("'around $300' is a range: down to half, up by a quarter; a plain bound stays as it is", () => {
  assert.deepEqual(approximate(300, 300, "a watch around $300"), { priceMin: 150, priceMax: 375 });
  assert.deepEqual(approximate(null, 60, "a budget of about $60"), { priceMin: 30, priceMax: 75 });
  assert.deepEqual(approximate(null, 300, "under 300"), { priceMin: null, priceMax: 300 });
  assert.deepEqual(approximate(20, 40, "between 20 and 40"), { priceMin: 20, priceMax: 40 });
  assert.deepEqual(approximate(null, 1000, "a laptop around 1k"), { priceMin: 500, priceMax: 1250 });
});

test("'around' widens only the bound written right after it, never a ceiling elsewhere in the message", () => {
  assert.deepEqual(approximate(null, 50, "about 3 shirts under $50"), { priceMin: null, priceMax: 50 });
  assert.deepEqual(approximate(null, 50, "a laptop around $300 and a perfume under 50"), { priceMin: null, priceMax: 50 });
  assert.deepEqual(approximate(10, null, "~5 items over $10"), { priceMin: 10, priceMax: null });
  assert.deepEqual(approximate(300, 300, "a laptop around $300 and a perfume under 50"), { priceMin: 150, priceMax: 375 });
});

test("an empty attribute list on a refine keeps the stored words; only `clear` removes them", () => {
  const first = intentToQuery(intent({ noun: "handbag", attributes: ["black"] }), "a black handbag").query;
  assert.deepEqual(patchQuery(first, intent({ attributes: [] }), "cheaper", []).query.attributes, ["black"]);
  assert.deepEqual(patchQuery(first, intent({ attributes: [], clear: ["attributes"] }), "any color", []).query.attributes, []);
});

test("exclusions come from the extraction and add up on a refine: 'not Chanel', then 'not Dior either'", () => {
  const first = intentToQuery(intent({ noun: "perfume", exclude: ["Chanel"] }), "perfume but not Chanel").query;
  assert.deepEqual(first.exclude, ["chanel"]);
  const next = patchQuery(first, intent({ exclude: ["dior"] }), "not dior either", []).query;
  assert.deepEqual(next.exclude, ["chanel", "dior"]);
});

test("a phrase matches when all its words are there", () => {
  const jordan = product(88, "Nike Air Jordan 1 Red And Black");
  assert.equal(matchesAll(jordan, ["nike air jordan"]), true);
  assert.equal(matchesAll(product(89, "Nike Baseball Cleats"), ["nike air jordan"]), false);
});

test("partial attributes: the products with the most asked words win", () => {
  const rows = [
    product(1, "White Faux Leather Backpack"),
    product(2, "Women Handbag Black"),
    product(3, "Heshe Women's Leather Bag"),
    product(4, "Blue Women's Handbag"),
  ];
  const leatherOnly = bestPartial(rows, ["black", "leather"]);
  assert.deepEqual(leatherOnly.rows.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(leatherOnly.kept, []);
  const both = bestPartial([...rows, product(5, "Black Leather Tote")], ["black", "leather"]);
  assert.deepEqual(both.rows.map((p) => p.id), [5]);
  assert.deepEqual(both.kept, ["black", "leather"]);
  assert.deepEqual(bestPartial(rows, ["silk"]).rows.length, 4);
});

// ---------- the retrieval ladder ----------

import type { CallCtx } from "../src/pipeline/ports.ts";
import type { Query } from "../src/messages/schema.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createFixtureApi } from "./fakes/catalog.ts";

const ctx = (): { ctx: CallCtx; events: Array<{ kind: string; data: Record<string, unknown> }> } => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  return { events, ctx: { budget: { remaining: () => 1e9, timeoutFor: (t) => t }, trace: { event: (kind, data) => void events.push({ kind, data }) } } };
};
const rq = (o: Partial<Query>): Query => ({
  category: null, noun: null, attributes: [], priceMin: null, priceMax: null, sort: "relevance",
  inStock: false, categoryStated: false, gender: null, top: false, within: null, purpose: null, exclude: [], offset: 0, ...o,
});

test("face cream is the face lotion by its keyword, not Ice Cream by the word cream", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "skin-care", noun: "cream", attributes: ["face"] }), c);
  assert.equal(r.match, "exact");
  assert.deepEqual(r.products.map((p) => p.title), ["Vaseline Men Body and Face Lotion"]);
});

test("running shoes are the sneakers by their keyword, though no title says running", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ noun: "shoe", attributes: ["running"] }), c);
  assert.equal(r.match, "exact");
  assert.deepEqual(r.products.map((p) => p.id).sort(), [90, 91, 92]);
});

test("a product type the catalog lacks is a miss, not the closest appliance: no kettle", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "kitchen-accessories", noun: "kettle", attributes: ["electric"] }), c);
  assert.equal(r.status, "miss");
});

test("the Air Jordan is a sneaker by its keyword head ('basketball sneaker')", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "mens-shoes", noun: "sneaker", attributes: ["nike"] }), c);
  assert.equal(r.match, "exact");
  assert.deepEqual(r.products.map((p) => p.title), ["Nike Air Jordan 1 Red And Black"]);
});

test("a brand and the product type are both kept: no Nike boot is a miss, never a Puma or another Nike shoe", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "mens-shoes", noun: "boot", attributes: ["nike"] }), c);
  assert.equal(r.status, "miss");
});

test("an excluded brand is never shown: perfume but not Chanel", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "fragrances", exclude: ["chanel"] }), c);
  assert.ok(r.products.length > 0);
  assert.ok(r.products.every((p) => !/chanel/i.test(p.title) && p.brand?.toLowerCase() !== "chanel"), r.products.map((p) => p.title).join(", "));
});

test("partial attributes: the black bag and the leather bag each keep one word", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "womens-bags", categoryStated: true, attributes: ["black", "leather"] }), c);
  assert.equal(r.match, "attributes_relaxed");
  const titles = r.products.map((p) => p.title);
  assert.ok(titles.includes("Women Handbag Black") && titles.includes("Heshe Women's Leather Bag"));
  assert.ok(!titles.includes("Blue Women's Handbag"));
});

test("enrichment: perfume for men excludes the women's perfumes, keeps the unisex one", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "fragrances", categoryStated: true, gender: "mens" }), c);
  assert.deepEqual(r.products.map((p) => p.title), ["Calvin Klein CK One"]);
});

test("enrichment: a whole keyword is the product type, a word inside a phrase is not", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ noun: "drink" }), c);
  const titles = r.products.map((p) => p.title);
  // every card is a drink (in rating order), never the cup whose keyword is "hot drink"
  assert.equal(r.total, 5);
  assert.ok(titles.every((t) => ["Juice", "Milk", "Nescafe Coffee", "Soft Drinks", "Water"].includes(t)));
  assert.ok(!titles.includes("Black Aluminium Cup")); // its keyword is "hot drink"
});

test("a superlative says which order it asks for, so 'the cheapest one' can pick a shown card", () => {
  assert.equal(superlativeSort("I want the cheapest one"), "price_asc");
  assert.equal(superlativeSort("the most expensive one"), "price_desc");
  assert.equal(superlativeSort("which is the best rated?"), "rating");
  assert.equal(superlativeSort("tell me about the second one"), null);
});

test("no white dress: other dresses, and the reply is told the color was dropped", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ noun: "dress", attributes: ["white"] }), c);
  assert.equal(r.match, "attributes_relaxed");
  assert.deepEqual(r.applied.attributes, []);
});

test("gold finds Golden by word", () => {
  assert.equal(singularize("golden"), "gold");
});

test("a tag names what a product is by its head: a 'camera accessory' is not a camera", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ noun: "camera", attributes: ["reflex"] }), c);
  // Monopod and Selfie Stick carry the tag "camera accessories"; "TV Studio Camera Pedestal" is a pedestal.
  // The catalog has no camera: an honest miss.
  assert.equal(r.status, "miss");
});

test("a relaxed match never drops a brand: no Samsung phone under $250 is a miss", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(
    rq({ category: "smartphones", categoryStated: true, attributes: ["samsung"], priceMax: 250 }), c);
  assert.equal(r.status, "miss");
});

import { resolveCategory } from "../src/slots/aliases.ts";
import type { ProductCard } from "../src/messages/schema.ts";

test("'cheaper' drops a minimum it contradicts: below the cheapest card shown, with no floor", () => {
  const stored = intentToQuery(intent({ category: "smartphones", priceMin: 100 }), "phones over 100").query;
  const shown = [{ price: 149.99 }, { price: 299.99 }] as ProductCard[];
  const p = patchQuery(stored, intent({ relativePrice: "cheaper" }), "something cheaper", shown).query;
  assert.equal(p.priceMax, 149.98);
  assert.equal(p.priceMin, null);
});

// ---------- a price belongs to the product it is written next to ----------

import { scopePrices } from "../src/pipeline/merge.ts";

const two = (a: Partial<ExtractedIntent>, b: Partial<ExtractedIntent>) => [intent(a), intent(b)];

test("'a laptop and a perfume under 50' copied onto both: the bound stays on the perfume only", () => {
  const [laptop, perfume] = scopePrices(two({ noun: "laptop", priceMax: 50 }, { noun: "perfume", priceMax: 50 }), "a laptop and a perfume under 50");
  assert.equal(laptop?.priceMax, null);
  assert.equal(perfume?.priceMax, 50);
});

test("'a laptop under 1000 and a perfume' copied onto both: the bound stays on the laptop only", () => {
  const [laptop, perfume] = scopePrices(two({ noun: "laptop", priceMax: 1000 }, { noun: "perfume", priceMax: 1000 }), "a laptop under 1000 and a perfume");
  assert.equal(laptop?.priceMax, 1000);
  assert.equal(perfume?.priceMax, null);
});

test("the bound is placed by its own number, not by a model number or a count before it", () => {
  const [phone, ear] = scopePrices(two({ noun: "iphone", priceMax: 200 }, { noun: "earphone", priceMax: 200 }), "an iphone 15 and earphones under $200");
  assert.deepEqual([phone?.priceMax, ear?.priceMax], [null, 200]);
  const [laptops, perfume] = scopePrices(two({ noun: "laptop", priceMax: 200 }, { noun: "perfume", priceMax: 200 }), "2 laptops and a perfume under 200");
  assert.deepEqual([laptops?.priceMax, perfume?.priceMax], [null, 200]);
  const [laptop, scent] = scopePrices(two({ noun: "laptop", priceMax: 1000 }, { noun: "perfume", priceMax: 1000 }), "a laptop under 1,000 and a perfume");
  assert.deepEqual([laptop?.priceMax, scent?.priceMax], [1000, null]);
});

test("a bound the message says covers both stays on both: 'both under 50', 'under 50: a laptop and a perfume'", () => {
  for (const text of ["a laptop and a perfume, both under 50", "a laptop and a perfume under 50 each", "under 50: a laptop and a perfume", "a laptop and a perfume, all under 50"]) {
    const out = scopePrices(two({ noun: "laptop", priceMax: 50 }, { noun: "perfume", priceMax: 50 }), text);
    assert.deepEqual(out.map((i) => i.priceMax), [50, 50], text);
  }
});

test("'all' or 'every' that isn't about the price doesn't spread a bound: 'an all-purpose cleaner'", () => {
  const out = scopePrices(two({ noun: "laptop", priceMax: 20 }, { noun: "cleaner", priceMax: 20 }), "a laptop and an all-purpose cleaner under 20");
  assert.deepEqual(out.map((i) => i.priceMax), [null, 20]);
});

test("a bound equal to a model number is placed by its price word: 'an iphone 15 case and a charger under 15'", () => {
  const out = scopePrices(two({ noun: "case", attributes: ["iphone"], priceMax: 15 }, { noun: "charger", priceMax: 15 }), "an iphone 15 case and a charger under 15");
  assert.deepEqual(out.map((i) => i.priceMax), [null, 15]);
});

test("a noun the user didn't write is placed by an attribute they did: 'running kicks' -> sneaker + running", () => {
  const out = scopePrices(two({ noun: "laptop", priceMax: 60 }, { noun: "sneaker", attributes: ["running"], priceMax: 60 }), "a laptop and running kicks under 60");
  assert.deepEqual(out.map((i) => i.priceMax), [null, 60]);
});

test("price scoping changes nothing it cannot place: different bounds, one intent, or a product word not in the text", () => {
  const different = two({ noun: "laptop", priceMax: 1000 }, { noun: "perfume", priceMax: 50 });
  assert.equal(scopePrices(different, "a laptop under 1000 and a perfume under 50"), different);
  const one = [intent({ noun: "laptop", priceMax: 50 })];
  assert.equal(scopePrices(one, "a laptop under 50"), one);
  // the extracted nouns are not the words the user wrote, so their position is unknown
  const other = two({ noun: "laptop", priceMax: 50 }, { noun: "perfume", priceMax: 50 });
  assert.equal(scopePrices(other, "a notebook and a scent under 50"), other);
});

test("a product-line word among the attributes still guesses its category: 'iphone' -> smartphones", () => {
  const r = resolveCategory({ category: null, noun: null, attributes: ["iphone"], utterance: "an iphone" });
  assert.equal(r.category, "smartphones");
  assert.deepEqual(r.attributes, ["iphone"]);
});

test("a price copied onto every item of a list stays on the item written before it; a second bound is left alone", () => {
  const list = [intent({ noun: "egg", priceMax: 10 }), intent({ noun: "case", priceMax: 10 }), intent({ noun: "ball", priceMax: 10 }), intent({ noun: "mug", priceMax: 10 })];
  const out = scopePrices(list, "eggs, an iphone case, a tennis ball under $10 and a mug");
  assert.deepEqual(out.map((i) => i.priceMax), [null, null, 10, null]);
  // two different bounds written next to their items: nothing to move
  const own = [intent({ noun: "egg", priceMax: 5 }), intent({ noun: "case", priceMax: 40 }), intent({ noun: "mug" })];
  assert.equal(scopePrices(own, "eggs under 5, a case under 40 and a mug"), own);
  // one bound before the list covers every item
  assert.deepEqual(scopePrices(list, "under $10: eggs, a case, a ball and a mug").map((i) => i.priceMax), [10, 10, 10, 10]);
});
