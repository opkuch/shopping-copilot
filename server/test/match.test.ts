import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RawProductFull } from "../src/pipeline/ports.ts";
import { normalizeWord, normalizeWords, singularize, tokenize } from "../src/slots/normalize.ts";
import { DENYLIST } from "../src/slots/denylist.ts";
import { resolveCategory } from "../src/slots/aliases.ts";
import { matchesAll, titleHits } from "../src/retrieval/match.ts";

const catalog = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")) as RawProductFull[];
const byTitle = (t: string) => {
  const p = catalog.find((c) => c.title === t);
  assert.ok(p, `fixture product missing: ${t}`);
  return p;
};
const matching = (words: string[]) => catalog.filter((p) => matchesAll(p, words)).map((p) => p.title);

test("singularize", () => {
  // eyewear stays "glasses" in queries and titles alike, apart from a drinking "glass"
  assert.equal(singularize("glasses"), "glasses");
  assert.deepEqual(tokenize("Party Glasses"), ["party", "glasses"]);
  assert.equal(singularize("glass"), "glass");
  assert.equal(singularize("watches"), "watch");
  assert.equal(singularize("dresses"), "dress");
  assert.equal(singularize("shoes"), "shoe");
  assert.equal(singularize("sunglasses"), "sunglass");
  assert.equal(singularize("glass"), "glass");
  assert.equal(singularize("boxes"), "box");
  assert.equal(singularize("Laptops"), "laptop");
  // naive on purpose: both sides get the same stem
  assert.equal(singularize("series"), "sery");
  assert.equal(singularize("Series"), singularize("sery"));
  assert.equal(singularize("batteries"), "battery");
  assert.equal(singularize("accessories"), "accessory");
  assert.equal(singularize("cookies"), "cookie");
  assert.equal(singularize("ties"), "tie");
  assert.equal(singularize("knives"), "knife");
});

test("tokenize splits, lowercases, singularizes and drops empties", () => {
  assert.deepEqual(tokenize("Rolex Submariner Watch, 18k!"), ["rolex", "submariner", "watch", "18k"]);
  assert.deepEqual(tokenize("  "), []);
  // possessive "s" singularizes to "" and disappears; "men's" keeps "men"
  assert.deepEqual(tokenize("men's watches"), ["men", "watch"]);
  assert.deepEqual(tokenize("Galaxy S8"), ["galaxy", "s8"]);
});

test("normalizeWord and normalizeWords", () => {
  assert.equal(normalizeWord("  Headphones "), "headphone");
  assert.equal(normalizeWord(""), null);
  assert.equal(normalizeWord("s"), null);
  assert.equal(normalizeWord("Cool"), null);
  assert.equal(normalizeWord("gifts"), null); // singular is denylisted
  assert.equal(normalizeWord("coolest"), null);
  for (const w of DENYLIST) assert.equal(normalizeWord(w), null, w);
  assert.equal(normalizeWords(null), null);
  assert.deepEqual(normalizeWords(["Red", "red", "cool", "Shoes", ""]), ["red", "shoe"]);
});

test("whole-token match avoids the substring noise measured on the live API", () => {
  assert.deepEqual(matching(["ring"]), []);
  assert.ok(catalog.some((p) => p.description.toLowerCase().includes("ring")), "fixture has substring noise");
  const laptops = catalog.filter((p) => p.category === "laptops");
  assert.ok(laptops.every((p) => !matchesAll(p, ["top"])));
  const phoneHits = matching(["phone"]);
  assert.ok(!phoneHits.includes("Beats Flex Wireless Earphones"));
  assert.ok(!phoneHits.includes("Apple AirPods Max Silver"));
  assert.ok(!phoneHits.includes("Apple Airpods"));
  assert.ok(matchesAll(byTitle("Rolex Submariner Watch"), ["watch"]));
  assert.ok(matchesAll(byTitle("Rolex Submariner Watch"), ["watch", "rolex"]));
  assert.ok(!matchesAll(byTitle("Rolex Submariner Watch"), ["watch", "red"]));
  assert.ok(matchesAll(byTitle("Rolex Submariner Watch"), []));
});

test("titleHits counts matched words in the title only", () => {
  const p = byTitle("Red Lipstick");
  assert.equal(titleHits(p, ["red", "lipstick"]), 2);
  assert.equal(titleHits(p, ["red", "nail"]), 1);
});

test("resolveCategory: synonyms drop the word, hints keep it", () => {
  const syn = resolveCategory({ category: null, noun: "laptop", attributes: ["red"], utterance: "a red laptop" });
  assert.deepEqual(syn, { category: "laptops", noun: null, attributes: ["red"], categoryStated: true });
  const hint = resolveCategory({ category: null, noun: "headphone", attributes: [], utterance: "headphones" });
  assert.deepEqual(hint, { category: "mobile-accessories", noun: "headphone", attributes: [], categoryStated: false });
  const none = resolveCategory({ category: null, noun: "case", attributes: ["phone"], utterance: "phone case" });
  assert.deepEqual(none, { category: null, noun: "case", attributes: ["phone"], categoryStated: false });
});

test("resolveCategory: extraction category wins; stated vs inferred", () => {
  const inferred = resolveCategory({ category: "smartphones", noun: "charger", attributes: [], utterance: "iphone charger" });
  assert.equal(inferred.category, "smartphones");
  assert.equal(inferred.noun, "charger");
  assert.equal(inferred.categoryStated, false);
  const stated = resolveCategory({ category: "smartphones", noun: "phone", attributes: ["phone", "red"], utterance: "a red phone" });
  assert.deepEqual(stated, { category: "smartphones", noun: null, attributes: ["red"], categoryStated: true });
});

test("resolveCategory: slug words count as stating the category", () => {
  const possessive = resolveCategory({ category: "mens-watches", noun: null, attributes: [], utterance: "men's watches" });
  assert.equal(possessive.categoryStated, true);
  const plain = resolveCategory({ category: "mens-watches", noun: "watch", attributes: [], utterance: "mens watch" });
  assert.equal(plain.categoryStated, true);
  const missingWord = resolveCategory({ category: "mens-watches", noun: "watch", attributes: [], utterance: "a watch" });
  assert.equal(missingWord.categoryStated, false);
  const grocery = resolveCategory({ category: "groceries", noun: null, attributes: [], utterance: "some groceries" });
  assert.equal(grocery.categoryStated, true);
  const nothing = resolveCategory({ category: null, noun: null, attributes: [], utterance: "hi" });
  assert.equal(nothing.categoryStated, false);
});
