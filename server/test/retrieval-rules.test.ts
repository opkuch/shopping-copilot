// Retrieval rules, each from a failure seen in testing: compounds, generic nouns, superlatives, shekels, partial attributes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtractedIntent } from "../src/messages/schema.ts";
import { asksForTop, foldCompound, intentToQuery, patchQuery, superlativeSort } from "../src/pipeline/merge.ts";
import type { RawProduct } from "../src/pipeline/ports.ts";
import { bestPartial } from "../src/retrieval/port.ts";
import { matchesAll } from "../src/retrieval/match.ts";
import { singularize } from "../src/slots/normalize.ts";

const intent = (o: Partial<ExtractedIntent> = {}): ExtractedIntent => ({
  category: null, noun: null, attributes: null, priceMin: null, priceMax: null, currency: null,
  relativePrice: null, sort: null, inStock: null, clear: [], gift: null, theme: null, ...o,
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
  assert.equal(asksForTop("הסמסונג הכי זול שיש לכם"), true);
  assert.equal(asksForTop("איזה תיק לאישה הכי מדורג אצלכם"), true);
  assert.equal(asksForTop("the most expensive men's Rolex"), true);
  assert.equal(asksForTop("the cheapest Samsung"), true);
  assert.equal(asksForTop("the cheapest phones"), false);
  assert.equal(asksForTop("הטלפונים הכי זולים"), false);
  assert.equal(asksForTop("cheap phones"), false);
});

test("a refine without a superlative is a list again", () => {
  const first = intentToQuery(intent({ noun: "phone", sort: "price_asc" }), "the cheapest phone").query;
  assert.equal(first.top, true);
  const next = patchQuery(first, intent({ priceMax: 500, currency: "USD" }), "under 500", []).query;
  assert.equal(next.top, false);
});

test("shekel bounds become dollars at the stated rate; other currencies are not applied", () => {
  const ils = intentToQuery(intent({ noun: "phone", priceMax: 1000, currency: "ILS" }), "טלפון עד 1000 שקל");
  assert.equal(ils.query.priceMax, 270);
  assert.equal(ils.currencyConverted, true);
  assert.equal(ils.currencyNotApplied, false);
  const eur = intentToQuery(intent({ noun: "phone", priceMax: 1000, currency: "other" }), "phone under 1000 euros");
  assert.equal(eur.query.priceMax, null);
  assert.equal(eur.currencyNotApplied, true);
  const usd = intentToQuery(intent({ noun: "phone", priceMax: 1000, currency: "USD" }), "phone under 1000");
  assert.equal(usd.currencyConverted, false);
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

import type { CallCtx, RetrievalQuery } from "../src/pipeline/ports.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createFixtureApi } from "./fakes/catalog.ts";

const ctx = (): { ctx: CallCtx; events: Array<{ kind: string; data: Record<string, unknown> }> } => {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  return { events, ctx: { budget: { remaining: () => 1e9, timeoutFor: (t) => t }, trace: { event: (kind, data) => void events.push({ kind, data }) } } };
};
const rq = (o: Partial<RetrievalQuery>): RetrievalQuery => ({
  category: null, noun: null, attributes: [], priceMin: null, priceMax: null, sort: "relevance",
  inStock: false, categoryStated: false, gender: null, top: false, within: null, purpose: null, offset: 0, ...o,
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

test("a brand outranks the noun: no Nike boot, so Nike's other shoes, not a Puma", async () => {
  const { ctx: c } = ctx();
  const r = await createRetriever(createFixtureApi()).retrieve(rq({ category: "mens-shoes", noun: "boot", attributes: ["nike"] }), c);
  assert.ok(r.products.length > 0);
  assert.ok(r.products.every((p) => p.title.startsWith("Nike")));
  assert.equal(r.applied.noun, null);
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
  assert.equal(superlativeSort("אני רוצה את הכי זול"), "price_asc");
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

test("the category fallback never drops a brand: no Samsung phone under $250 is a miss", async () => {
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

test("a bound the message says covers both stays on both: 'both under 50', 'under 50: a laptop and a perfume'", () => {
  for (const text of ["a laptop and a perfume, both under 50", "a laptop and a perfume under 50 each", "under 50: a laptop and a perfume"]) {
    const out = scopePrices(two({ noun: "laptop", priceMax: 50 }, { noun: "perfume", priceMax: 50 }), text);
    assert.deepEqual(out.map((i) => i.priceMax), [50, 50], text);
  }
});

test("price scoping changes nothing it cannot place: different bounds, one intent, or a product word not in the text", () => {
  const different = two({ noun: "laptop", priceMax: 1000 }, { noun: "perfume", priceMax: 50 });
  assert.equal(scopePrices(different, "a laptop under 1000 and a perfume under 50"), different);
  const one = [intent({ noun: "laptop", priceMax: 50 })];
  assert.equal(scopePrices(one, "a laptop under 50"), one);
  // Hebrew: the extracted nouns are English, so their position in the message is unknown
  const he = two({ noun: "laptop", priceMax: 50 }, { noun: "perfume", priceMax: 50 });
  assert.equal(scopePrices(he, "מחשב נייד ובושם עד 50"), he);
});

test("a product-line word among the attributes still guesses its category: 'iphone' -> smartphones", () => {
  const r = resolveCategory({ category: null, noun: null, attributes: ["iphone"], utterance: "an iphone" });
  assert.equal(r.category, "smartphones");
  assert.deepEqual(r.attributes, ["iphone"]);
});

test("a reply that says a converted shekel limit was not applied is rejected for the template", async () => {
  const { contradictsDraft } = await import("../src/reply/compose.ts");
  const input = { kind: "results" as const, language: "he" as const, message: "שעונים לגבר עד 5000 שקל", previous: null, groups: [],
    draft: "הנה תוצאה אחת עבור שעונים. המחירים בדולרים; המרתי משקלים לפי כ-3.7 ₪ לדולר." };
  assert.equal(contradictsDraft("המחיר מוצג בדולרים, והבקשה עד 5,000 ₪ לא הוחלה.", input), true);
  assert.equal(contradictsDraft("מצאתי שעון אחד עד כ-$1,351.", input), false);
});
