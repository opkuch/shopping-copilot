// Scripted turns, run through the real orchestrator, real store (temp SQLite
// file), real retrieval over the fixture catalog, and scripted model fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCategoryNames } from "../src/catalog/cache.ts";
import type { AssistantMessage, Group, Stage } from "../src/messages/schema.ts";
import { createBudget } from "../src/pipeline/budget.ts";
import { labelFor } from "../src/pipeline/merge.ts";
import { createReplyWriter } from "../src/reply/compose.ts";
import { resultsSentence } from "../src/reply/templates.ts";
import { createTurnRunner } from "../src/pipeline/runTurn.ts";
import { CallFailed } from "../src/pipeline/ports.ts";
import type { ReplyWriter, Retriever, Store, TurnOutcome } from "../src/pipeline/ports.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import { createFixtureApi } from "./fakes/catalog.ts";
import {
  createFakeRouter, createFakeSlots, createFakeWriter, extraction, gate, hangUntilAborted, intent, routerResult,
} from "./fakes/models.ts";
import type { Step } from "./fakes/models.ts";
import type { ExtractionResult, Preview, RouterResult } from "../src/messages/schema.ts";
import type { ExtractInput, ProseInput, RouterInput } from "../src/pipeline/ports.ts";
import { CURATED, giftCategories } from "../src/pipeline/purpose.ts";

type Wrap = {
  retriever?: (real: Retriever) => Retriever;
  writer?: (fake: ReplyWriter) => ReplyWriter;
  store?: (real: Store) => Store;
  apiOpts?: Parameters<typeof createFixtureApi>[0];
};

function harness(wrap: Wrap = {}) {
  const dir = mkdtempSync(join(tmpdir(), "turns-"));
  const opened = openDatabase(join(dir, "c.sqlite"));
  const realStore = createStore(opened.db, { warning: opened.warning });
  const store = wrap.store ? wrap.store(realStore) : realStore;
  const api = createFixtureApi(wrap.apiOpts);
  const log: string[] = [];
  const router = createFakeRouter(log);
  const slots = createFakeSlots(log);
  const writer = createFakeWriter(log);
  const realRetriever = createRetriever(api);
  const runner = createTurnRunner({
    store,
    router,
    slots,
    retriever: wrap.retriever ? wrap.retriever(realRetriever) : realRetriever,
    categories: createCategoryNames(api, { ttlMs: 3_600_000, now: Date.now }),
    catalog: api,
    writer: wrap.writer ? wrap.writer(writer) : writer,
  });
  const state = { conversationId: null as string | null, revision: 0, id: "" };

  type Script = {
    router: Step<RouterInput, RouterResult>;
    /** Omitted: extraction hangs until aborted, which is what a turn that needs no slots should do to it. */
    extract?: Step<ExtractInput, ExtractionResult>;
    write?: Step<ProseInput, string | null>;
  };

  function start(text: string, script: Script) {
    const id = randomUUID();
    const accepted = state.conversationId === null
      ? store.acceptFirst(id, text)
      : store.acceptMessage(state.conversationId, id, text, state.revision);
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind !== "accepted") throw new Error("unreachable");
    state.conversationId = accepted.conversationId;
    state.revision = accepted.revision;
    state.id = id;
    router.queue(script.router);
    slots.queue(script.extract ?? ((_i, ctx) => hangUntilAborted(ctx.signal)));
    // Only refer turns call the writer. Unscripted, the fake's "no step" error becomes null, like a failed call.
    if (script.write !== undefined) writer.queue(script.write);
    const args = { conversationId: accepted.conversationId, revision: accepted.revision, userMessage: accepted.userMessage };
    return { id, args, outcome: runner.run(args) };
  }
  async function say(text: string, script: Script) {
    const t = start(text, script);
    return { id: t.id, outcome: await t.outcome };
  }
  const productCalls = () => api.calls.filter((c) => c.method !== "categories");
  return { store, api, router, slots, writer, log, runner, state, start, say, productCalls };
}

function done(outcome: TurnOutcome): AssistantMessage {
  assert.equal(outcome.kind, "completed", `expected completed, got ${JSON.stringify(outcome)}`);
  if (outcome.kind !== "completed") throw new Error("unreachable");
  return outcome.response.assistantMessage;
}
const q = (g: Group | undefined) => (g as Group).query;
const search = (...i: Parameters<typeof intent>[0][]) => extraction(i.map((x) => intent(x)));
const tick = () => new Promise<void>((r) => setImmediate(r));

// ---------- no-catalog turns ----------

test("greeting, service, and off_topic get their template and touch no product endpoint", async () => {
  const h = harness();
  const greeting = done((await h.say("hi", { router: routerResult({ act: "chat", chatKind: "greeting" }) })).outcome);
  assert.equal(greeting.text, "I can help you find products in our catalog.");

  // act is new_search but nothing is shoppable: the domain guard wins over the act
  const service = done((await h.say("a flight to Tokyo", { router: routerResult({ act: "new_search", domain: "service" }) })).outcome);
  assert.equal(service.text, "I can't book trips or other services, or check on orders and deliveries; for an order, please contact the store's customer service. I can help you find products. Try one of these:");
  assert.ok(service.suggestions.length > 0, "a next step: example searches");

  const poem = done((await h.say("write me a poem", { router: routerResult({ act: "new_search", domain: "off_topic" }) })).outcome);
  assert.equal(poem.text, "That's outside what I can help with. I find products in this shop's catalog. Try one of these:");
  assert.ok(poem.suggestions.length > 0);
  assert.doesNotMatch(poem.text, /flight|travel/);

  assert.deepEqual(h.productCalls(), []);
  for (const m of [greeting, service, poem]) assert.deepEqual(m.groups, []);
  assert.equal(h.writer.calls.length, 0, "templates never call the prose model");
});

test("catalog overview names the cached categories; with no cache it says the list is unavailable", async () => {
  const warm = harness();
  const text = done((await warm.say("what do you sell?", { router: routerResult({ act: "chat", chatKind: "catalog_overview" }) })).outcome).text;
  assert.match(text, /^I can help you find products in our catalog\. Categories include: Beauty, Fragrances, Furniture,/);
  assert.deepEqual(warm.productCalls(), []);

  const cold = harness();
  cold.api.failNext.categories = new CallFailed("network", "down");
  const unavailable = done((await cold.say("what do you sell?", { router: routerResult({ act: "chat", chatKind: "catalog_overview" }) })).outcome).text;
  assert.equal(unavailable, "I can help you find products in our catalog. The category list is unavailable right now.");
});

test("a router refusal on act is a 200 refusal template, not a failure", async () => {
  const h = harness();
  const { id, outcome } = await h.say("something the model refuses", { router: routerResult({ refused: true }) });
  assert.equal(done(outcome).text, "I can't help with that. I can help you find products in our catalog.");
  assert.deepEqual(h.productCalls(), []);
  assert.equal(h.store.traces(id)[0]?.outcome, "completed");
});

test("an extraction refusal is the same refusal template", async () => {
  const h = harness();
  const { outcome } = await h.say("refused slots", { router: routerResult(), extract: { refused: true } });
  assert.equal(done(outcome).text, "I can't help with that. I can help you find products in our catalog.");
  assert.deepEqual(h.productCalls(), []);
});

// ---------- new searches ----------

// router.v2: the note is for a service the user asks for ("and a flight"), not one mentioned as context
// ("for my flight"); which phrasing gets the flag is the live eval's job, the mechanism is this test's.
test("headphones and a flight to Tokyo: headphones retrieved, service sentence appended", async () => {
  const h = harness();
  const { outcome } = await h.say("Headphones and a flight to Tokyo", {
    router: routerResult({ mentionsService: true }),
    extract: search({ noun: "headphones" }),
  });
  const m = done(outcome);
  const g = m.groups[0] as Group;
  assert.equal(g.status, "results");
  assert.equal(q(g).noun, "headphone", "the hint keeps the word in the filter");
  assert.equal(q(g).category, "mobile-accessories");
  assert.ok(g.products.length > 0);
  assert.match(m.text, /I can't book travel or other services\.$/);
});

test("cheap and cool sunglasses: category sunglasses, price_asc, no 'cool' anywhere in the query", async () => {
  const h = harness();
  const { outcome } = await h.say("Cheap and cool sunglasses", {
    router: routerResult(),
    // the model leaked the denylist word into attributes; code must strip it
    extract: search({ category: "sunglasses", noun: "sunglasses", attributes: ["cool"], sort: "price_asc" }),
  });
  const g = done(outcome).groups[0] as Group;
  assert.equal(q(g).category, "sunglasses");
  assert.equal(q(g).sort, "price_asc");
  assert.doesNotMatch(JSON.stringify(g.query), /cool/);
  const inStock = g.products.filter((p) => p.inStock).map((p) => p.price);
  assert.deepEqual(inStock, [...inStock].sort((a, b) => a - b));
  assert.equal(g.products[0]?.price, 19.99);
});

test("something cheap and cool: a curated browse of the cheapest product per category, with chips to narrow it", async () => {
  const h = harness();
  const { outcome } = await h.say("Something cheap and cool", {
    router: routerResult(),
    extract: search({ noun: "cool", attributes: ["cool"], sort: "price_asc" }),
  });
  const m = done(outcome);
  assert.deepEqual(q(m.groups[0]), {
    category: null, noun: null, attributes: [], priceMin: null, priceMax: null, sort: "price_asc", inStock: false, gender: null, categoryStated: false, top: false, within: CURATED, purpose: "curated", offset: 0,
  });
  assert.deepEqual(h.productCalls().map((c) => c.method), ["all"]);
  const products = m.groups[0]?.products ?? [];
  assert.equal(products.length, 4);
  // Not four groceries: one card per curated category, cheapest first.
  assert.equal(new Set(products.map((p) => p.category)).size, 4);
  assert.ok(products.every((p) => CURATED.includes(p.category as never)));
  assert.deepEqual(products.map((p) => p.price), products.map((p) => p.price).toSorted((a, b) => a - b));
  assert.ok(products.every((p) => p.rating >= 4), "a recommendation: no 3-star fork or 2.9-star shuttlecock");
  assert.match(m.text, /varied pick: 4 lowest-priced products from different categories/);
  assert.equal(m.groups[0]?.label, "Picks");
  assert.ok(m.suggestions.length > 0);
});

test("no intent at all: the default order across categories, and the reply claims no order", async () => {
  const h = harness();
  const { outcome } = await h.say("show me something", { router: routerResult(), extract: extraction([]) });
  const m = done(outcome);
  assert.equal(q(m.groups[0]).sort, "relevance");
  assert.deepEqual(h.productCalls().map((c) => c.method), ["all"]);
  assert.equal(new Set(m.groups[0]?.products.map((p) => p.category)).size, 4);
  assert.equal(m.text, "Here's a varied pick: 4 products from different categories. Tell me a budget or a kind of product to narrow it down.");
  assert.equal(m.groups[0]?.label, "Picks");
});

test("a white dress in Hebrew: no category guessed, no white dress exists, so other dresses are shown and the reply says so", async () => {
  const h = harness();
  const { outcome } = await h.say("אני רוצה שמלה לבנה", {
    router: routerResult(),
    extract: search({ noun: "dress", attributes: ["white"] }),
  });
  const m = done(outcome);
  const g = m.groups[0] as Group;
  assert.equal(g.status, "results");
  assert.equal(g.match, "attributes_relaxed");
  assert.deepEqual(q(g).attributes, []);
  assert.equal(q(g).noun, "dress");
  // Dresses live in two categories in this catalog, and most titles never say "dress".
  assert.ok(g.products.every((p) => p.category === "womens-dresses" || p.category === "tops"));
  assert.equal(g.total, 10);
  // The writer was unscripted (a failed call), so the reply is the Hebrew template draft.
  assert.equal(m.text, 'אין התאמה ל-"white" בקטגוריה שמלות. הנה מוצרים אחרים בקטגוריה.');
  const call = h.writer.calls.at(-1)?.input;
  assert.equal(call?.kind, "results");
  assert.equal(call?.kind === "results" ? call.language : null, "he");
});

test("a Hebrew miss gets the Hebrew template", async () => {
  const h = harness();
  const { outcome } = await h.say("טיסה ללונדון", {
    router: routerResult(),
    extract: search({ noun: "zzzz", priceMax: 50 }),
  });
  const m = done(outcome);
  assert.equal(m.groups[0]?.status, "miss");
  assert.match(m.text, /^לא מצאתי בקטלוג "Zzzzes" עד \$50\.$/);
});

test("Hebrew templates answer chat and service turns in Hebrew", async () => {
  const h = harness();
  const hi = done((await h.say("שלום", { router: routerResult({ act: "chat", chatKind: "greeting" }) })).outcome);
  assert.equal(hi.text, "אני יכול לעזור לך למצוא מוצרים בקטלוג שלנו.");
  const flight = done((await h.say("טיסה לטוקיו", { router: routerResult({ domain: "service" }) })).outcome);
  assert.match(flight.text, /להזמין נסיעות או שירותים אחרים/);
});

test("men's watch: the gender picks the category instead of being matched as text", async () => {
  const h = harness();
  const { outcome } = await h.say("men's watch", { router: routerResult(), extract: search({ noun: "watch", attributes: ["men's"] }) });
  const m = done(outcome);
  const g = m.groups[0] as Group;
  assert.equal(g.match, "exact");
  // The 6 men's watches plus the unisex Apple Watch (mobile-accessories); never a women's watch.
  assert.equal(g.total, 7);
  assert.ok(g.products.every((p) => p.category !== "womens-watches"));
});

test("red headphones: no red ones exist, so other headphones are shown, never chargers", async () => {
  const h = harness();
  const { outcome } = await h.say("red headphones", { router: routerResult(), extract: search({ noun: "headphones", attributes: ["red"] }) });
  const m = done(outcome);
  const g = m.groups[0] as Group;
  assert.equal(g.match, "attributes_relaxed");
  assert.ok(g.products.length > 0);
  assert.ok(!g.products.some((p) => /charger/i.test(p.title)));
  assert.match(m.text, /I couldn't find red headphones in our catalog\. Here are other headphones\./);
});

test("a laptop and a fragrance under 50: two groups, the bound belongs to the fragrance alone", async () => {
  const h = harness();
  const { outcome } = await h.say("A laptop and a fragrance under 50", {
    router: routerResult(),
    extract: search({ noun: "laptop" }, { noun: "fragrance", priceMax: 50, currency: "USD" }),
  });
  const m = done(outcome);
  assert.equal(m.groups.length, 2);
  assert.equal(q(m.groups[0]).priceMax, null);
  assert.equal(q(m.groups[1]).priceMax, 50);
  assert.deepEqual(m.groups.map((g) => g.label), ["Laptops", "Fragrances"]);
  assert.ok(m.groups[1]?.products.every((p) => p.price <= 50));
});

test("a laptop, a perfume, and a watch: first two looked up, the sentence says so", async () => {
  const h = harness();
  const { outcome } = await h.say("A laptop, a perfume, and a watch", {
    router: routerResult(),
    extract: extraction([intent({ noun: "laptop" }), intent({ noun: "perfume" })], 1),
  });
  const m = done(outcome);
  assert.equal(m.groups.length, 2);
  assert.match(m.text, /I only looked up the first two\./);
});

test("a results turn: when the writer fails, the template draft is the reply", async () => {
  const h = harness();
  const { id, outcome } = await h.say("laptops", {
    router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }), write: null,
  });
  const m = done(outcome);
  assert.equal(m.groups[0]?.products.length, 4);
  assert.equal(m.text, "Here are 4 of 5 laptops, lowest price first.");
  assert.equal(h.store.getConversation(h.state.conversationId as string)?.messages.length, 2);
  assert.equal((h.store.traces(id)[0]?.trace as { reply: string }).reply, "template");
});

test("a results turn: the writer answers the message from the facts, cards in shown order", async () => {
  const h = harness();
  const { id, outcome } = await h.say("show me cheap laptops", {
    router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }),
    write: "The cheapest is the Lenovo Yoga 920 at $1099.99.",
  });
  const m = done(outcome);
  assert.equal(m.text, "The cheapest is the Lenovo Yoga 920 at $1099.99.");
  const input = h.writer.calls.at(-1)?.input;
  assert.ok(input?.kind === "results");
  assert.equal(input.message, "show me cheap laptops");
  assert.equal(input.draft, "Here are 4 of 5 laptops, lowest price first.");
  assert.deepEqual(input.groups[0]?.cards.map((c) => c.position), [1, 2, 3, 4]);
  assert.equal(input.groups[0]?.cards[0]?.price, 1099.99);
  assert.equal(input.groups[0]?.outcome, "results");
  assert.equal((h.store.traces(id)[0]?.trace as { reply: string }).reply, "model");
});

test("a results turn: the writer sees the previous exchange, so it can tell a repeat from a new answer", async () => {
  const h = harness();
  await h.say("cheap laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }), write: null });
  await h.say("thanks! anything else around that price?", {
    router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }), write: null,
  });
  const input = h.writer.calls.at(-1)?.input;
  assert.ok(input?.kind === "results");
  assert.deepEqual(input.previous, { user: "cheap laptops", assistant: "Here are 4 of 5 laptops, lowest price first." });
});

test("under 50 euros: the bound is not applied and the sentence says why", async () => {
  const h = harness();
  const { outcome } = await h.say("laptops under 50 euros", {
    router: routerResult(), extract: search({ category: "laptops", priceMax: 50, currency: "other" }),
  });
  const m = done(outcome);
  assert.equal(q(m.groups[0]).priceMax, null);
  assert.equal(m.groups[0]?.products.length, 4);
  assert.match(m.text, /Prices are in US dollars, so I didn't apply that price limit\./);
});

test("shekels the model called 'other' are still shekels when the message says so", async () => {
  const h = harness();
  const { outcome } = await h.say("טלפון עד 1000 שקל", {
    router: routerResult(), extract: search({ category: "smartphones", priceMax: 1000, currency: "other" }),
  });
  const m = done(outcome);
  assert.equal(q(m.groups[0]).priceMax, 270);
  assert.match(m.text, /3\.7/);
});

test("a singular superlative names the winner; the runners-up stay as cards", async () => {
  const h = harness();
  const { outcome } = await h.say("what's the cheapest laptop?", {
    router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }), write: null,
  });
  const m = done(outcome);
  assert.equal(m.groups[0]?.products[0]?.title, "Lenovo Yoga 920");
  assert.equal(m.groups[0]?.products.length, 4);
  assert.equal(m.text, "The lowest-priced of 5 laptops is Lenovo Yoga 920 at $1099.99. The next ones follow.");
  const input = h.writer.calls.at(-1)?.input;
  assert.ok(input?.kind === "results");
  assert.equal(input.groups[0]?.request.topIsFirst, true);
});

test("a Hebrew query: retrieval uses the English noun the extraction returned", async () => {
  const h = harness();
  const { outcome } = await h.say("שפתון אדום", {
    router: routerResult(), extract: search({ noun: "lipstick", attributes: ["red"] }),
  });
  const m = done(outcome);
  assert.equal(q(m.groups[0]).noun, "lipstick");
  assert.deepEqual(h.productCalls(), [{ method: "all", arg: null }]);
  assert.equal(m.groups[0]?.products[0]?.title, "Red Lipstick");
});

// ---------- refine ----------

test("cheap laptops then under 1000: refine keeps price_asc and the category and adds priceMax", async () => {
  const h = harness();
  await h.say("Cheap laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) });
  const second = await h.say("under 1000", { router: routerResult({ act: "refine" }), extract: search({ priceMax: 1000, currency: "USD" }) });
  const m = done(second.outcome);
  const queried = (h.store.traces(second.id)[0]?.trace as { queries: Array<{ query: unknown }> }).queries[0]?.query;
  assert.deepEqual(queried, {
    category: "laptops", noun: null, attributes: [], priceMin: null, priceMax: 1000, sort: "price_asc", inStock: false, gender: null, categoryStated: true, top: false, within: null, purpose: null, offset: 0,
  });
  // the cheapest laptop is $1099.99, so this is a miss that restates what was asked; the laptops
  // already on screen stay the working query instead of an empty group
  assert.equal(m.text, "I couldn't find laptops at or under $1000 in our catalog. The earlier results are still below.");
  assert.equal(m.groups[0]?.status, "results");
  assert.equal(q(m.groups[0]).priceMax, null);
  // the router and extractor saw the stored query and the cards on screen
  assert.equal(h.router.calls[1]?.input.storedQueries.length, 1);
  assert.equal(h.router.calls[1]?.input.shownCards.length, 4);
});

test("a stated category stays stated on a refine: iphones in smartphones, then cheaper, never leaves smartphones", async () => {
  const h = harness();
  const first = done((await h.say("iphone in smartphones", {
    router: routerResult(), extract: search({ category: "smartphones", noun: "iphone" }),
  })).outcome);
  assert.equal(q(first.groups[0]).categoryStated, true);
  const m = done((await h.say("cheaper", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) })).outcome);
  // nothing cheaper than the iPhone 5s exists, so the iPhones stay; before, chargers and cases appeared
  assert.equal(m.text, "Nothing in this search is cheaper than $199.99.");
  assert.ok(m.groups[0]?.products.every((p) => p.category === "smartphones"));
});

test("gender is kept across relaxation and refines: men's trail shoes, then in black, stays men's", async () => {
  const h = harness();
  const first = done((await h.say("trail shoes for men under 100", {
    router: routerResult(), extract: search({ category: "mens-shoes", noun: "shoe", attributes: ["trail", "men"], priceMax: 100, currency: "USD" }),
  })).outcome);
  assert.equal(q(first.groups[0]).gender, "mens");
  assert.match(first.text, /^I couldn't find trail shoes in our catalog\. Here are other shoes\.$/);
  const m = done((await h.say("in black", { router: routerResult({ act: "refine" }), extract: search({ attributes: ["black"] }) })).outcome);
  assert.equal(q(m.groups[0]).gender, "mens");
  assert.ok(m.groups[0]?.products.every((p) => !p.category.startsWith("womens-")), JSON.stringify(m.groups[0]?.products.map((p) => p.title)));
});

test("make both cheaper with two different patches applies each to its own group", async () => {
  const h = harness();
  await twoGroups(h);
  const turn = await h.say("laptops under 1500 and the fragrance under 60", {
    router: routerResult({ act: "refine", targetGroup: "both" }),
    extract: search({ priceMax: 1500, currency: "USD" }, { priceMax: 60, currency: "USD" }),
  });
  const m = done(turn.outcome);
  assert.doesNotMatch(m.text, /send the other change separately/);
  const queried = (h.store.traces(turn.id)[0]?.trace as {
    queries: Array<{ query: { priceMax: number | null } }>;
  }).queries.map((x) => x.query.priceMax);
  assert.deepEqual(queried, [1500, 60]);
});

test("cheaper with one group: priceMax is the cheapest shown price minus a cent", async () => {
  const h = harness();
  await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_desc" }) });
  const m = done((await h.say("cheaper", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) })).outcome);
  assert.equal(q(m.groups[0]).priceMax, 1399.98);
  assert.equal(q(m.groups[0]).sort, "price_desc", "the sort stays as stored");
  assert.deepEqual(m.groups[0]?.products.map((p) => p.price), [1099.99]);
});

test("cheaper with nothing cheaper: the group is copied forward unchanged and the sentence says so", async () => {
  const h = harness();
  const first = done((await h.say("cheap laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) })).outcome);
  const said = await h.say("cheaper", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) });
  const m = done(said.outcome);
  assert.match(JSON.stringify(h.store.traces(said.id)), /refine_kept_previous/);
  // the same cards, carried forward and marked so the client does not draw them twice
  assert.deepEqual(m.groups, first.groups.map((g) => ({ ...g, repeat: true })));
  assert.equal(m.groups[0]?.status, "results");
  assert.equal(m.text, "Nothing in this search is cheaper than $1099.99.");
  // The working query is still the shown search: a second "cheaper" derives the same bound, not a stacked one.
  const again = done((await h.say("cheaper still", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) })).outcome);
  assert.deepEqual(again.groups, first.groups.map((g) => ({ ...g, repeat: true })));
  assert.equal(again.text, "Nothing in this search is cheaper than $1099.99.");
  const bounds = h.api.calls.filter((c) => c.method === "byCategory").length;
  assert.equal(bounds, 3);
});

test("pricier with nothing pricier: the group is kept and the 'nothing costs more' sentence is used", async () => {
  const h = harness();
  const first = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_desc" }) })).outcome);
  const m = done((await h.say("pricier", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "pricier" }) })).outcome);
  assert.deepEqual(m.groups, first.groups.map((g) => ({ ...g, repeat: true })));
  assert.equal(m.text, "Nothing in this search costs more than $1999.99.");
});

test("a refine of one group describes only that group; the kept group is not re-announced", async () => {
  const h = harness();
  const before = done((await twoGroups(h)).outcome);
  const m = done((await h.say("the laptops under 1500", {
    router: routerResult({ act: "refine", targetGroup: "first" }), extract: search({ priceMax: 1500 }),
  })).outcome);
  assert.deepEqual(m.groups[1], { ...before.groups[1], repeat: true });
  assert.doesNotMatch(m.text, /fragrance/i);
});

test("laptop and fragrance results sentences name their subjects", async () => {
  const h = harness();
  const m = done((await h.say("a laptop and a fragrance", {
    router: routerResult(), extract: search({ noun: "laptop" }, { noun: "fragrance", priceMax: 50, currency: "USD" }),
  })).outcome);
  assert.match(m.text, /^Here are \d+ (of \d+ )?laptops\. Here (are \d+ (of \d+ )?(fragrances|fragrance)|is 1 (of \d+ )?(products? in Fragrances|fragrance))\.$/);
});

const twoGroups = (h: ReturnType<typeof harness>) =>
  h.say("a laptop and a fragrance", {
    router: routerResult(),
    extract: search({ category: "laptops", sort: "price_desc" }, { category: "fragrances", sort: "price_desc" }),
  });

test("cheaper with two groups and target unclear: ask which group, no fetch, working query unchanged", async () => {
  const h = harness();
  const first = done((await twoGroups(h)).outcome);
  h.api.reset();
  const { outcome } = await h.say("cheaper", {
    router: routerResult({ act: "refine", targetGroup: "unclear" }), extract: search({ relativePrice: "cheaper" }),
  });
  assert.equal(done(outcome).text, "Which one should I change: Laptops or Fragrances?");
  assert.deepEqual(h.api.calls, []);
  assert.equal(h.store.workingQuery(h.state.conversationId as string)?.messageId, first.id);
  // The answer names a group; the stored "cheaper" is applied to it, though the router said refer.
  const m = done((await h.say("the laptops", {
    router: routerResult({ act: "refer", targetGroup: "first" }), extract: search({}),
  })).outcome);
  assert.deepEqual(m.groups.map((g) => q(g).priceMax), [1399.98, null]);
});

test("cheaper with target both: both groups are re-fetched, each with its own bound", async () => {
  const h = harness();
  await twoGroups(h);
  h.api.reset();
  const m = done((await h.say("make both cheaper", {
    router: routerResult({ act: "refine", targetGroup: "both" }), extract: search({ relativePrice: "cheaper" }),
  })).outcome);
  assert.deepEqual(m.groups.map((g) => q(g).priceMax), [1399.98, 69.98]);
  assert.deepEqual(h.productCalls().map((c) => c.method).sort(), ["byCategory", "byCategory"]);
});

test("make both cheaper with the patch repeated per group (as the live model returns it) is one change, not two", async () => {
  const h = harness();
  await twoGroups(h);
  const m = done((await h.say("make both cheaper", {
    router: routerResult({ act: "refine", targetGroup: "both" }),
    extract: search({ relativePrice: "cheaper" }, { relativePrice: "cheaper" }),
  })).outcome);
  assert.deepEqual(m.groups.map((g) => q(g).priceMax), [1399.98, 69.98]);
  assert.doesNotMatch(m.text, /send the other change separately/);
});

test("a target of first re-fetches only that group and copies the other forward unchanged", async () => {
  const h = harness();
  const before = done((await twoGroups(h)).outcome);
  h.api.reset();
  const m = done((await h.say("the laptops under 1500", {
    router: routerResult({ act: "refine", targetGroup: "first" }), extract: search({ priceMax: 1500 }),
  })).outcome);
  assert.equal(q(m.groups[0]).priceMax, 1500);
  assert.deepEqual(m.groups[1], { ...before.groups[1], repeat: true });
  assert.deepEqual(h.productCalls(), [{ method: "byCategory", arg: "laptops" }]);
  assert.equal(m.groups.length, 2, "a later refine still sees two groups");
});

test("any price on a refine: clear price removes both bounds", async () => {
  const h = harness();
  const a = done((await h.say("laptops between 1200 and 1500", {
    router: routerResult(), extract: search({ category: "laptops", priceMin: 1200, priceMax: 1500, currency: "USD" }),
  })).outcome);
  assert.equal(q(a.groups[0]).priceMin, 1200);
  const b = done((await h.say("any price", {
    router: routerResult({ act: "refine" }), extract: search({ clear: ["price"] }),
  })).outcome);
  assert.equal(q(b.groups[0]).priceMin, null);
  assert.equal(q(b.groups[0]).priceMax, null);
  assert.equal(q(b.groups[0]).category, "laptops");
});

test("a refine with no working query is treated as a new search", async () => {
  const h = harness();
  const m = done((await h.say("cheaper laptops", {
    router: routerResult({ act: "refine" }), extract: search({ category: "laptops", sort: "price_asc" }),
  })).outcome);
  assert.equal(m.groups[0]?.status, "results");
  assert.equal(q(m.groups[0]).sort, "price_asc");
});

test("a refine carrying two patches applies the first and says the other must be sent separately", async () => {
  const h = harness();
  await twoGroups(h);
  const m = done((await h.say("laptop cheaper and perfume under 30", {
    router: routerResult({ act: "refine", targetGroup: "first" }),
    extract: search({ relativePrice: "cheaper" }, { priceMax: 30 }),
  })).outcome);
  assert.equal(q(m.groups[0]).priceMax, 1399.98);
  assert.equal(q(m.groups[1]).priceMax, null);
  assert.match(m.text, /I changed one thing; send the other change separately\./);
});

test("a refine with no intent re-runs the stored query unchanged", async () => {
  const h = harness();
  const a = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) })).outcome);
  const b = done((await h.say("hmm", { router: routerResult({ act: "refine" }), extract: extraction([]) })).outcome);
  assert.deepEqual(b.groups, a.groups);
});

// ---------- refer ----------

test("the second one: detail is fetched for the chosen card id", async () => {
  const h = harness();
  const a = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) })).outcome);
  const second = a.groups[0]?.products[1];
  h.api.reset();
  const m = done((await h.say("tell me about the second one", { router: routerResult({ act: "refer", referTarget: 2 }) })).outcome);
  assert.deepEqual(h.api.calls, [{ method: "product", arg: second?.id }]);
  assert.deepEqual(m.groups, []);
  assert.equal(m.detail?.id, second?.id);
  assert.equal(m.detail?.source, "live");
  assert.equal(m.detail?.inStock, true);
  assert.equal(typeof m.detail?.reviewCount, "number");
  assert.equal(m.text, `Here are more details about ${second?.title}.`);
});

test("'I want the cheapest one': an unclear reference with a superlative picks the cheapest shown card", async () => {
  const h = harness();
  const a = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "rating" }) })).outcome);
  const cheapest = [...(a.groups[0]?.products ?? [])].sort((x, y) => x.price - y.price)[0];
  const m = done((await h.say("I want the cheapest one", { router: routerResult({ act: "refer", referTarget: "unclear" }) })).outcome);
  assert.equal(m.detail?.id, cheapest?.id);
});

test("the Rolex: refer resolves a named card; on detail failure the reply uses the stored card", async () => {
  const h = harness();
  const a = done((await h.say("watches", { router: routerResult(), extract: search({ category: "mens-watches", sort: "price_asc" }) })).outcome);
  const cards = a.groups[0]?.products ?? [];
  const idx = cards.findIndex((p) => /Rolex/.test(p.title)) + 1;
  assert.ok(idx > 0);
  h.api.failNext.product = new CallFailed("timeout", "slow");
  const writesBefore = h.writer.calls.length;
  const m = done((await h.say("tell me about the Rolex", { router: routerResult({ act: "refer", referTarget: idx }) })).outcome);
  const card = cards[idx - 1];
  assert.equal(m.detail?.id, card?.id);
  assert.equal(m.detail?.source, "stored_card");
  assert.equal(m.detail?.description, card?.description);
  assert.equal(m.detail?.brand, null);
  assert.equal(m.text, `Here are more details about ${card?.title}. More details are unavailable right now.`);
  assert.equal(h.writer.calls.length, writesBefore, "no prose model when the live detail is missing");
});

test("refer after an intervening thanks still resolves against the working query", async () => {
  const h = harness();
  const a = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) })).outcome);
  await h.say("thanks", { router: routerResult({ act: "chat", chatKind: "greeting" }) });
  const m = done((await h.say("the third one", { router: routerResult({ act: "refer", referTarget: 3 }) })).outcome);
  assert.equal(m.detail?.id, a.groups[0]?.products[2]?.id);
});

test("a refer message does not become the working query", async () => {
  const h = harness();
  const a = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) })).outcome);
  await h.say("the first", { router: routerResult({ act: "refer", referTarget: 1 }) });
  assert.equal(h.store.workingQuery(h.state.conversationId as string)?.messageId, a.id);
});

test("refer with nothing on screen, and refer with an unclear target, use their templates", async () => {
  const h = harness();
  const none = done((await h.say("the second one", { router: routerResult({ act: "refer", referTarget: null }) })).outcome);
  assert.equal(none.text, "There are no products on screen yet. What are you looking for?");
  await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) });
  h.api.reset();
  const unclear = done((await h.say("that one", { router: routerResult({ act: "refer", referTarget: "unclear" }) })).outcome);
  assert.equal(unclear.text, "Which one? You can say a number from 1 to 4 or a product name.");
  assert.deepEqual(h.api.calls, []);
});

// ---------- failures ----------

test("router failure: no assistant row, the catalog is never called, the failed trace is stored", async () => {
  const h = harness();
  const { id, outcome } = await h.say("laptops", { router: new CallFailed("timeout", "router timed out"), extract: search({ category: "laptops" }) });
  assert.equal(outcome.kind, "reply_failed");
  assert.deepEqual(h.api.calls, []);
  const conv = h.store.getConversation(h.state.conversationId as string);
  assert.deepEqual(conv?.messages.map((m) => m.role), ["user"]);
  assert.equal(h.store.traces(id)[0]?.outcome, "reply_failed");
  if (outcome.kind === "reply_failed") {
    assert.deepEqual(outcome, { kind: "reply_failed", conversationId: conv?.id, revision: 1, userMessageId: id });
  }
});

test("extraction failure on a product turn: no assistant row, the catalog is never called", async () => {
  const h = harness();
  const { id, outcome } = await h.say("laptops", { router: routerResult(), extract: new CallFailed("http", "502", 502) });
  assert.equal(outcome.kind, "reply_failed");
  assert.deepEqual(h.api.calls, []);
  assert.deepEqual(h.store.getConversation(h.state.conversationId as string)?.messages.map((m) => m.role), ["user"]);
  assert.equal(h.store.traces(id)[0]?.outcome, "reply_failed");
});

test("extraction failing on a chat turn does not matter: it was never needed", async () => {
  const h = harness();
  const { outcome } = await h.say("hi", { router: routerResult({ act: "chat" }), extract: new CallFailed("http", "502", 502) });
  assert.equal(outcome.kind, "completed");
});

test("one of two fetches fails: one group unavailable, the other kept, label named in the sentence", async () => {
  const h = harness({ apiOpts: { failWhen: (m, arg) => (m === "byCategory" && arg === "fragrances" ? new CallFailed("timeout", "t") : null) } });
  const m = done((await h.say("a laptop and a fragrance", {
    router: routerResult(), extract: search({ category: "laptops" }, { category: "fragrances" }),
  })).outcome);
  assert.deepEqual(m.groups.map((g) => g.status), ["results", "unavailable"]);
  assert.deepEqual(m.groups[1], {
    label: "Fragrances", status: "unavailable", match: "none", total: 0, products: [],
    query: { category: "fragrances", noun: null, attributes: [], priceMin: null, priceMax: null, sort: "relevance", inStock: false, gender: null, categoryStated: true, top: false, within: null, purpose: null, offset: 0 },
  });
  assert.match(m.text, /I couldn't load Fragrances right now\.$/);
});

test("every fetch fails: reply_failed, user message kept", async () => {
  const h = harness({ apiOpts: { failWhen: (m) => (m === "byCategory" ? new CallFailed("timeout", "t") : null) } });
  const { id, outcome } = await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) });
  assert.equal(outcome.kind, "reply_failed");
  assert.equal(h.store.getConversation(h.state.conversationId as string)?.messages.length, 1);
  assert.equal(h.store.traces(id)[0]?.outcome, "reply_failed");
});

test("a failed fetch on one refined group does not count the copied-forward group as a success", async () => {
  const h = harness();
  await twoGroups(h);
  h.api.failNext.byCategory = new CallFailed("timeout", "t");
  const { outcome } = await h.say("the laptops cheaper", {
    router: routerResult({ act: "refine", targetGroup: "first" }), extract: search({ relativePrice: "cheaper" }),
  });
  assert.equal(outcome.kind, "reply_failed");
});

test("storage throwing on the assistant write: reply_failed, user message kept, reply not stored", async () => {
  const h = harness({
    store: (real) => ({ ...real, storeAssistant() { throw new Error("disk full"); } }),
  });
  const { id, outcome } = await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) });
  assert.equal(outcome.kind, "reply_failed");
  const conv = h.store.getConversation(h.state.conversationId as string);
  assert.deepEqual(conv?.messages.map((m) => m.role), ["user"]);
  assert.equal(h.store.traces(id)[0]?.outcome, "reply_failed");
});

test("a late assistant is dropped with reason not_tail when a newer user message arrived mid-turn", async () => {
  const h = harness();
  const { id, outcome } = await h.say("laptops", {
    router: routerResult(),
    extract: async () => {
      // another tab sends while this turn is running; the revision it holds is the current one
      const r = h.store.acceptMessage(h.state.conversationId as string, randomUUID(), "newer message", h.state.revision);
      assert.equal(r.kind, "accepted");
      return extraction([intent({ category: "laptops" })]);
    },
  });
  assert.deepEqual(outcome, { kind: "dropped", reason: "not_tail" });
  const conv = h.store.getConversation(h.state.conversationId as string);
  assert.deepEqual(conv?.messages.map((m) => m.role), ["user", "user"]);
  assert.equal(h.store.traces(id)[0]?.outcome, "dropped");
});

// ---------- concurrency, stages, traces ----------

test("router and extraction are both started before either resolves", async () => {
  const h = harness();
  const gr = gate();
  const ge = gate();
  const t = h.start("laptops", {
    router: async () => { await gr.promise; return routerResult(); },
    extract: async () => { await ge.promise; return extraction([intent({ category: "laptops" })]); },
  });
  await tick();
  assert.deepEqual(h.log.slice(0, 2), ["router:start", "extract:start"]);
  assert.ok(!h.log.some((e) => e.endsWith(":end")), "neither has finished yet");
  gr.open();
  ge.open();
  assert.equal(done(await t.outcome).groups[0]?.status, "results");
});

test("a chat turn aborts extraction and ignores its rejection", async () => {
  const h = harness();
  const { outcome } = await h.say("hi", { router: routerResult({ act: "chat" }) }); // extraction hangs until aborted
  assert.equal(outcome.kind, "completed");
  assert.equal(h.slots.calls[0]?.signal?.aborted, true);
  await tick(); // an unhandled rejection from the aborted call would fail the run here
});

test("a refer turn aborts extraction too", async () => {
  const h = harness();
  await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) });
  await h.say("the first", { router: routerResult({ act: "refer", referTarget: 1 }) });
  assert.equal(h.slots.calls[1]?.signal?.aborted, true);
});

test("a resend while the turn is in flight shares one pipeline run", async () => {
  const h = harness();
  const g = gate();
  const t = h.start("laptops", {
    router: async () => { await g.promise; return routerResult(); },
    extract: search({ category: "laptops" }),
  });
  await tick();
  const again = h.runner.run(t.args);
  assert.equal(again, t.outcome, "the lock hands back the promise already in flight");
  g.open();
  const [a, b] = await Promise.all([t.outcome, again]);
  assert.deepEqual(a, b);
  assert.equal(h.router.calls.length, 1);
  assert.equal(h.slots.calls.length, 1);
  assert.equal(h.runner.stage(t.id), "idle");
});

test("stage reports classifying, searching, then idle; only a refer turn reaches writing", async () => {
  const seen: Stage[] = [];
  const h = harness({
    retriever: (real) => ({ retrieve(query, ctx) { seen.push(h.runner.stage(h.state.id)); return real.retrieve(query, ctx); } }),
  });
  assert.equal(h.runner.stage("nope"), "idle");
  const { id, outcome } = await h.say("laptops", {
    router: () => { seen.push(h.runner.stage(h.state.id)); return routerResult(); },
    extract: search({ category: "laptops" }),
  });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(seen, ["classifying", "searching"]);
  assert.equal(h.runner.stage(id), "idle");

  const refer = await h.say("the first", {
    router: routerResult({ act: "refer", referTarget: 1 }),
    write: () => { seen.push(h.runner.stage(h.state.id)); return null; },
  });
  assert.equal(refer.outcome.kind, "completed");
  assert.equal(seen.at(-1), "writing");
});

test("cards first: while the writer works, progress already has the cards and the template sentence", async () => {
  const h = harness();
  const box: { seen: Preview | null } = { seen: null };
  const { id, outcome } = await h.say("laptops", {
    router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }),
    write: () => { box.seen = h.runner.preview(h.state.id); return "The cheapest is the Lenovo Yoga 920."; },
  });
  const m = done(outcome);
  assert.deepEqual(box.seen?.groups[0]?.products.map((p) => p.id), m.groups[0]?.products.map((p) => p.id));
  assert.equal(box.seen?.text, "Here are 4 of 5 laptops, lowest price first.");
  assert.equal(h.runner.preview(id), null, "cleared when the turn settles");
});

test("the trace carries prompt versions, router answers, raw extraction, queries and timing, and no secrets", async () => {
  const h = harness();
  const { id } = await h.say("laptops", {
    router: routerResult({ answers: { act: { value: "new_search", probability: 0.93, refused: false } } }),
    extract: search({ category: "laptops" }),
  });
  const row = h.store.traces(id)[0];
  assert.equal(row?.outcome, "completed");
  assert.equal(row?.attempt, 1);
  const t = row?.trace as Record<string, any>;
  assert.deepEqual(Object.keys(t.promptVersions).sort(), ["extraction", "prose", "router"]);
  assert.equal(t.router.answers.act.probability, 0.93);
  assert.equal(t.extraction.intents[0].category, "laptops");
  assert.equal(t.queries[0].query.category, "laptops");
  assert.equal(typeof t.queries[0].categoryStated, "boolean");
  assert.equal(typeof t.totalMs, "number");
  assert.ok(t.events.some((e: { kind: string }) => e.kind === "retrieval"), "module trace events are collected");
  assert.doesNotMatch(JSON.stringify(t), /authorization|bearer|api[_-]?key|sk-/i);
});

test("a second attempt of the same message gets the next attempt number", async () => {
  const h = harness();
  const first = h.start("laptops", { router: new CallFailed("timeout", "t") });
  assert.equal((await first.outcome).kind, "reply_failed");
  h.router.queue(routerResult());
  h.slots.queue(search({ category: "laptops" }));
  h.writer.queue(null);
  assert.equal((await h.runner.run(first.args)).kind, "completed");
  assert.deepEqual(h.store.traces(first.id).map((t) => [t.attempt, t.outcome]), [[1, "reply_failed"], [2, "completed"]]);
});

test("chat is guarded before domain: a greeting the router calls off_topic still gets the greeting", async () => {
  const h = harness();
  const m = done((await h.say("hello", { router: routerResult({ act: "chat", domain: "off_topic" }) })).outcome);
  assert.equal(m.text, "I can help you find products in our catalog.");
});

test("refer with a live detail lets the prose model phrase it", async () => {
  const h = harness();
  await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) });
  const m = done((await h.say("the first", { router: routerResult({ act: "refer", referTarget: 1 }), write: "It is a laptop." })).outcome);
  assert.equal(m.text, "It is a laptop.");
  assert.equal(h.writer.calls.at(-1)?.input.kind, "refer");
});

// ---------- prose facts, templates, labels ----------

const baseQuery = (over: Partial<Group["query"]> = {}): Group["query"] => ({
  category: null, noun: null, attributes: [], priceMin: null, priceMax: null, sort: "relevance", inStock: false, gender: null, categoryStated: false, top: false, within: null, purpose: null, offset: 0, ...over,
});
const card = (id: number) => ({ id, title: `P${id}`, description: "d", price: id, thumbnail: "t", rating: 4, category: "laptops", inStock: true });
const grp = (query: Group["query"], n: number, total: number, over: Partial<Group> = {}): Group => ({
  label: "X", status: "results", match: "exact", query, products: Array.from({ length: n }, (_, i) => card(i + 1)), total, ...over,
});
const noFlags = {
  droppedIntents: false, mentionsService: false, currencyNotApplied: false,
  secondPatchIgnored: false, noCheaper: null, noPricier: null,
};

test("the reply writer's facts are the product and the language name", async () => {
  const bodies: Array<{ input: Array<{ content: string }> }> = [];
  const client = {
    responses: {
      create: async (body: unknown) => {
        bodies.push(body as (typeof bodies)[number]);
        return { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] };
      },
    },
  } as unknown as Parameters<typeof createReplyWriter>[0];
  const c = card(7);
  const detail = { ...c, brand: "B", availabilityStatus: null, warrantyInformation: null, shippingInformation: null, returnPolicy: null, reviewCount: 3, source: "live" as const };
  const out = await createReplyWriter(client).write({ kind: "refer", language: "he", detail, message: "הוא מתאים לגיימינג?" }, { budget: createBudget(), trace: { event() {} } });
  assert.equal(out, "ok");
  const facts = JSON.parse(bodies[0]?.input[1]?.content as string);
  assert.equal(facts.language, "Hebrew");
  assert.equal(facts.message, "הוא מתאים לגיימינג?", "the writer sees the question, so it can answer it");
  assert.equal(facts.product.title, "P7");
  assert.equal(facts.product.brand, "B");
});

test("results sentences always name the subject and use the singular for one card", () => {
  const lap = baseQuery({ noun: "laptop" });
  assert.equal(resultsSentence(grp(lap, 4, 5), null), "Here are 4 of 5 laptops.");
  assert.equal(resultsSentence(grp(lap, 3, 3), null), "Here are 3 laptops.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "charger" }), 1, 1), null), "Here is 1 charger.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "charger" }), 1, 4), null), "Here is 1 of 4 chargers.");
  assert.equal(resultsSentence(grp(baseQuery({ category: "laptops" }), 4, 5), [{ slug: "laptops", name: "Laptops" } as never]), "Here are 4 of 5 laptops.");
  const frag = [{ slug: "fragrances", name: "Fragrances" } as never];
  assert.equal(resultsSentence(grp(baseQuery({ category: "fragrances" }), 1, 1), frag), "Here is 1 fragrance.");
  assert.equal(resultsSentence(grp(baseQuery({ category: "fragrances", sort: "price_asc" }), 1, 3), frag), "Here is 1 of 3 fragrances, lowest price first.");
  // A category that is a place, not a countable thing, is counted as products in it.
  const skin = [{ slug: "skin-care", name: "Skin Care" } as never];
  assert.equal(resultsSentence(grp(baseQuery({ category: "skin-care" }), 3, 3), skin), "Here are 3 products in Skin Care.");
  assert.equal(resultsSentence(grp(baseQuery({ category: "womens-bags" }), 4, 5), null), "Here are 4 of 5 women's bags.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "knife" }), 2, 2), null), "Here are 2 knives.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "jewellery" }), 1, 1), null), "Here is 1 jewellery item.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "charger" }), 1, 1), null), "Here is 1 charger.");
  assert.equal(resultsSentence(grp(baseQuery({ priceMax: 50 }), 2, 7), null), "Here are 2 of 7 products.");
  assert.equal(resultsSentence(grp(baseQuery({ priceMax: 50 }), 1, 1), null), "Here is 1 product.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "laptop", sort: "price_asc" }), 4, 5), null), "Here are 4 of 5 laptops, lowest price first.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "laptop", sort: "price_desc" }), 5, 5), null), "Here are 5 laptops, highest price first.");
  assert.equal(resultsSentence(grp(baseQuery({ noun: "laptop", sort: "price_desc" }), 1, 1), null), "Here is 1 laptop, highest price first.");
  assert.equal(resultsSentence(grp(baseQuery({ sort: "rating" }), 4, 100), null), "Here are 4 highly rated products from different categories. Tell me a category or a budget to narrow it down.");
  assert.equal(resultsSentence(grp(baseQuery({ sort: "price_asc" }), 4, 194), null), "Here are the lowest-priced products from 4 different categories. Tell me a category or a budget to narrow it down.");
});

test("group labels are pluralized and capitalized for nouns, display names for categories", () => {
  assert.equal(labelFor(baseQuery({ noun: "charger" }), null), "Chargers");
  assert.equal(labelFor(baseQuery({ noun: "perfume" }), null), "Perfumes");
  assert.equal(labelFor(baseQuery({ noun: "watch" }), null), "Watches");
  assert.equal(labelFor(baseQuery({ category: "laptops" }), [{ slug: "laptops", name: "Laptops" } as never]), "Laptops");
  assert.equal(labelFor(baseQuery(), null), "Products");
});

// ---------- vague and gift requests ----------

test("a gift with no budget asks one question with chips; the answer is read with what it knew", async () => {
  const h = harness();
  const asked = done((await h.say("מתנה לאבא", { router: routerResult(), extract: search({ gift: true, attributes: ["men"] }) })).outcome);
  assert.deepEqual(asked.groups, []);
  assert.match(asked.text, /מתנה/);
  assert.ok(asked.suggestions.some((s) => s.text === "עד 100 דולר"));
  assert.ok(!asked.suggestions.some((s) => s.text === "בשבילו"), "the recipient is known, so it is not asked");

  // "Up to $100" alone: the router may call it chat; it is the answer to the question.
  const answered = done((await h.say("משהו עד 100 דולר", {
    router: routerResult({ act: "chat" }), extract: search({ priceMax: 100, currency: "USD" }),
  })).outcome);
  const g = answered.groups[0];
  assert.equal(g?.label, "רעיונות למתנה"); // a Hebrew chat gets Hebrew group labels
  assert.equal(g?.query.gender, "mens");
  assert.ok((g?.products.length ?? 0) > 0);
  assert.ok(g?.products.every((p) => p.price <= 100 && !p.category.startsWith("womens-") && p.category !== "groceries"));
  assert.match(answered.text, /רעיונות למתנה בשבילו עד \$100/);
});

test("a gift question is asked once: answering only who it is for shows ideas for her, with budget chips", async () => {
  const h = harness();
  const asked = done((await h.say("אני מחפש מתנה", { router: routerResult(), extract: search({ gift: true }) })).outcome);
  assert.deepEqual(asked.groups, []);
  const answered = done((await h.say("בשבילה", {
    router: routerResult({ act: "chat" }), extract: search({ attributes: ["women"] }),
  })).outcome);
  const g = answered.groups[0];
  assert.equal(g?.query.purpose, "gift");
  assert.equal(g?.query.gender, "womens");
  assert.ok((g?.products.length ?? 0) > 0);
  assert.ok(g?.products.every((p) => !p.category.startsWith("mens-")));
  assert.ok(answered.suggestions.some((s) => s.text === "עד 100 דולר"), "the budget is offered as a chip, not asked again");
  assert.ok(!answered.suggestions.some((s) => s.text === "בשבילה"), "the recipient is known");
});

test("after the question, a kind of product keeps the recipient: 'perfume' for dad is a men's perfume", async () => {
  const h = harness();
  await h.say("a gift for my dad", { router: routerResult(), extract: search({ gift: true, attributes: ["men"] }) });
  const m = done((await h.say("perfume", { router: routerResult(), extract: search({ noun: "perfume", category: "fragrances" }) })).outcome);
  assert.deepEqual(m.groups[0]?.products.map((p) => p.title), ["Calvin Klein CK One"]);
});

test("a place with no product named asks what kind of product, never shows a guessed set", async () => {
  const h = harness();
  const m = done((await h.say("something for the beach", { router: routerResult(), extract: search({ theme: "beach" }) })).outcome);
  assert.deepEqual(m.groups, []);
  assert.match(m.text, /What kind of product/);
});

test("a kid's gift with a budget is shown at once: balls, gadgets, sunglasses within the budget", async () => {
  const h = harness();
  const m = done((await h.say("מתנה לילד בן 10 עד 50 דולר", {
    router: routerResult(), extract: search({ gift: true, attributes: ["kid"], priceMax: 50, currency: "USD" }),
  })).outcome);
  const products = m.groups[0]?.products ?? [];
  assert.ok(products.length > 0);
  assert.ok(products.every((p) => p.price <= 50 && ["sports-accessories", "mobile-accessories", "sunglasses"].includes(p.category)));
});

test("a wedding is a gift: no budget, so one question", async () => {
  const h = harness();
  const m = done((await h.say("צריכה משהו לחתונה של חברה", { router: routerResult(), extract: search({ theme: "wedding" }) })).outcome);
  assert.deepEqual(m.groups, []);
  assert.ok(m.suggestions.some((s) => s.text === "עד 50 דולר"));
});


// ---------- the missing intents ----------

test("show more: the next cards are appended to the same search, then 'that's all'", async () => {
  const h = harness();
  const first = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops", sort: "price_asc" }) })).outcome);
  assert.equal(first.groups[0]?.products.length, 4);
  const more = done((await h.say("תראה עוד", { router: routerResult({ act: "refer", referTarget: "unclear" }) })).outcome);
  const g = more.groups[0];
  // like "load more": the first four stay, the fifth is added after them
  assert.equal(g?.products.length, 5);
  assert.deepEqual(g?.products.slice(0, 4).map((p) => p.id), first.groups[0]?.products.map((p) => p.id));
  assert.equal(g?.shownFrom, 4, "the first four are in the message above: the client draws only the fifth");
  assert.match(more.text, /5 מתוך 5/);
  const none = done((await h.say("show more", { router: routerResult({ act: "more" }) })).outcome);
  assert.match(none.text, /That's all 5/);
});

test("'tell me about the Longines': a new search that picked a shown card and asks about it is a reference", async () => {
  const h = harness();
  const a = done((await h.say("men's watches", { router: routerResult(), extract: search({ category: "mens-watches" }) })).outcome);
  const second = a.groups[0]?.products[1];
  const m = done((await h.say("tell me about the Longines", { router: routerResult({ act: "new_search", referTarget: 2 }) })).outcome);
  assert.equal(m.detail?.id, second?.id);
});

test("'tell me about it' with one card on screen is that card, even when the domain says off topic", async () => {
  const h = harness();
  const a = done((await h.say("laptops under 1100", { router: routerResult(), extract: search({ category: "laptops", priceMax: 1100, currency: "USD" }) })).outcome);
  assert.equal(a.groups[0]?.products.length, 1);
  const m = done((await h.say("ספר לי עליו", { router: routerResult({ act: "refer", domain: "off_topic", referTarget: "unclear" }) })).outcome);
  assert.equal(m.detail?.id, a.groups[0]?.products[0]?.id);
});

test("'and for a woman?' on men's watches is women's watches", async () => {
  const h = harness();
  await h.say("men's watches", { router: routerResult(), extract: search({ category: "mens-watches", attributes: ["men"] }) });
  const m = done((await h.say("and for a woman?", { router: routerResult({ act: "refine" }), extract: search({ attributes: ["women"] }) })).outcome);
  assert.equal(m.groups[0]?.query.category, "womens-watches");
  assert.ok((m.groups[0]?.products.length ?? 0) > 0);
});

test("cheaper is the same search: no white sneaker cheaper is a miss, never a relaxed search", async () => {
  const h = harness();
  await h.say("white sneakers", { router: routerResult(), extract: search({ noun: "sneaker", attributes: ["white"], category: "mens-shoes" }) });
  const said = await h.say("a bit cheaper", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) });
  const m = done(said.outcome);
  const t = h.store.traces(said.id)[0]?.trace;
  assert.deepEqual((t as unknown as { flags: { noCheaper: unknown } }).flags.noCheaper, { price: 109.99 });
  assert.ok(m.groups[0]?.products.every((p) => /white/i.test(p.title)), "the earlier white sneakers stay");
});

test("one of two searches finds nothing: its old cards do not stay on screen under 'none'", async () => {
  const h = harness();
  await h.say("earrings and perfume under 100", {
    router: routerResult(), extract: extraction([intent({ category: "womens-jewellery" }), intent({ category: "fragrances", priceMax: 100, currency: "USD" })]),
  });
  const m = done((await h.say("and under 30?", {
    router: routerResult({ act: "refine", targetGroup: "both" }), extract: search({ priceMax: 30, currency: "USD" }),
  })).outcome);
  const cards = m.groups.flatMap((g) => g.products);
  assert.ok(cards.length > 0);
  assert.ok(cards.every((p) => p.price <= 30));
});

test("next steps under results come from the screen: more, cheaper", async () => {
  const h = harness();
  const m = done((await h.say("laptops", { router: routerResult(), extract: search({ category: "laptops" }) })).outcome);
  assert.deepEqual(m.suggestions.map((s) => s.text), ["show more", "something cheaper"]);
  const he = done((await h.say("שעונים לגבר", { router: routerResult(), extract: search({ category: "mens-watches", attributes: ["men"] }) })).outcome);
  assert.equal(he.groups[0]?.label, "שעוני גברים");
  assert.ok(he.suggestions.every((s) => /[֐-׿]/.test(s.label)), "Hebrew chips in a Hebrew chat");
});

// ---------- conversation memory and rejection (from a real conversation) ----------

test("a gift for her, then rejecting earrings: the gift and the recipient are remembered, jewellery is left out", async () => {
  const h = harness();
  // 1. the gift question
  await h.say("אני רוצה לקנות מתנה לחברה שלי", { router: routerResult(), extract: search({ gift: true, attributes: ["women"] }) });
  // 2. a kind from the chips
  const jewels = done((await h.say("תכשיטים", { router: routerResult(), extract: search({ category: "womens-jewellery", noun: "jewelry", gift: true }) })).outcome);
  assert.ok(jewels.groups[0]?.products.every((p) => p.category === "womens-jewellery"));
  // 3. "actually something else, up to $100": what is shown is rejected; the gift for her is not forgotten
  const other = done((await h.say("אהה בעצם משהו אחר עד 100 דולר", {
    router: routerResult({ act: "refine" }), extract: search({ priceMax: 100, currency: "USD" }),
  })).outcome);
  const g = other.groups[0];
  assert.equal(g?.query.purpose, "gift");
  assert.equal(g?.query.gender, "womens");
  assert.ok((g?.products.length ?? 0) > 0);
  assert.ok(g?.products.every((p) => p.category !== "womens-jewellery" && p.price <= 100), "no earrings again");
  // 4. "not jewelry, something else", the router's reject act: still her gift ideas
  const said = await h.say("לא תכשיטים משהו אחר", { router: routerResult({ act: "reject" }), extract: search({}) });
  const again = done(said.outcome);
  assert.ok(again.groups[0]?.products.every((p) => p.category !== "womens-jewellery" && !["groceries", "kitchen-accessories"].includes(p.category)));
  assert.ok(again.groups[0]?.products.every((p) => p.price <= 100), "the $100 budget from the turn before still applies");
  assert.equal(again.groups[0]?.query.gender, "womens");
  assert.equal((h.store.traces(said.id)[0]?.trace as { rejectedBy?: string }).rejectedBy, "router");
});

test("rejecting by words is only a backup: a rejection that names the new product is a search for it", async () => {
  const h = harness();
  await h.say("earrings", { router: routerResult(), extract: search({ category: "womens-jewellery", noun: "earring" }) });
  // The router missed the rejection (said refine); the words and an empty extraction still reject.
  const words = await h.say("something else", { router: routerResult({ act: "refine" }), extract: search({}) });
  assert.ok(done(words.outcome).groups[0]?.products.every((p) => p.category !== "womens-jewellery"));
  assert.equal((h.store.traces(words.id)[0]?.trace as { rejectedBy?: string }).rejectedBy, "words");
  // "Not earrings, a watch": the extraction names a watch, so the words do not reject; it is a watch search.
  const watch = done((await h.say("not earrings, a watch", {
    router: routerResult({ act: "new_search" }), extract: search({ noun: "watch" }),
  })).outcome);
  assert.ok((watch.groups[0]?.products.length ?? 0) > 0);
  assert.ok(watch.groups[0]?.products.every((p) => /watch/i.test(p.title) && p.category !== "womens-jewellery"), "watches, not a browse without earrings");
});

test("the models are told what the conversation is about", async () => {
  const h = harness();
  await h.say("a gift for my wife", { router: routerResult(), extract: search({ gift: true, attributes: ["women"] }) });
  await h.say("up to $100", { router: routerResult({ act: "chat" }), extract: search({ priceMax: 100, currency: "USD" }) });
  const seen: Array<unknown> = [];
  await h.say("something cheaper", {
    router: (input) => { seen.push(input.memory); return routerResult({ act: "refine" }); },
    extract: search({ relativePrice: "cheaper" }),
  });
  assert.deepEqual(seen[0], { purpose: { gift: true, gender: "womens", kid: false, theme: null }, excluded: [] });
});

test("a Valentine's gift: romantic categories, the budget steers the ranking, lifting it changes the cards", async () => {
  const h = harness();
  await h.say("אני רוצה לקנות מתנה ליום האהבה", { router: routerResult(), extract: search({ gift: true, theme: "valentine" }) });
  const budget = done((await h.say("עד 200 דולר", { router: routerResult(), extract: search({ priceMax: 200, currency: "USD" }) })).outcome);
  const cards = budget.groups[0]?.products ?? [];
  assert.ok(cards.length > 0);
  assert.ok(cards.every((p) => p.price <= 200 && !["kitchen-accessories", "groceries", "mobile-accessories"].includes(p.category)), "romantic, never a lunch box");
  assert.ok((cards[0]?.price ?? 0) >= 50, "the first ideas use the budget");
  const open = done((await h.say("בלי הגבלת מחיר", { router: routerResult({ act: "refine" }), extract: search({ clear: ["price"] }) })).outcome);
  assert.notDeepEqual(open.groups[0]?.products.map((p) => p.id), cards.map((p) => p.id), "no limit is not the same four cards");
});

// ---------- the default order ----------

test("with no order asked for, the best-rated products lead; an explicit order always wins", async () => {
  const h = harness();
  const plain = done((await h.say("watches for men", { router: routerResult(), extract: search({ category: "mens-watches", attributes: ["men"] }) })).outcome);
  const ratings = plain.groups[0]?.products.map((p) => p.rating) ?? [];
  assert.deepEqual(ratings, [...ratings].sort((x, y) => y - x), "highest rated first");
  const cheap = done((await h.say("cheap watches for men", { router: routerResult(), extract: search({ category: "mens-watches", attributes: ["men"], sort: "price_asc" }) })).outcome);
  assert.equal(cheap.groups[0]?.products[0]?.price, 89.99, "the shopper's 'cheap' wins");
});

test("'and under $30?' with two searches on screen and no product named applies to both, without asking", async () => {
  const h = harness();
  await h.say("earrings and perfume", { router: routerResult(), extract: extraction([intent({ category: "womens-jewellery" }), intent({ category: "fragrances" })]) });
  const m = done((await h.say("ומה עם משהו מתחת ל-30?", {
    router: routerResult({ act: "refine", targetGroup: "unclear" }), extract: search({ priceMax: 30, currency: "USD" }),
  })).outcome);
  assert.ok(m.groups.flatMap((g) => g.products).every((p) => p.price <= 30));
  assert.ok(!/איזה|which/i.test(m.text), "no 'which one?' question");
});

test("after 'nothing cheaper' the next steps stay (show more), without offering 'cheaper' again", async () => {
  const h = harness();
  await h.say("cheapest phone", { router: routerResult(), extract: search({ category: "smartphones", sort: "price_asc" }) });
  const m = done((await h.say("something cheaper", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "cheaper" }) })).outcome);
  const texts = m.suggestions.map((s) => s.text);
  assert.ok(texts.includes("show more"));
  assert.ok(!texts.includes("something cheaper"));
});

// ---------- changing your mind: a message replaces what it says, the rest carries over ----------

const gift200 = () => search({ gift: true, attributes: ["women"], priceMax: 200, currency: "USD" });
const dearest = (m: AssistantMessage) => Math.max(...(m.groups[0]?.products.map((p) => p.price) ?? []));

test("'more expensive' after a $200 gift budget replaces the range: above what was shown, no $200 cap", async () => {
  const h = harness();
  const first = done((await h.say("a gift for my wife under $200", { router: routerResult(), extract: gift200() })).outcome);
  const top = dearest(first);
  const m = done((await h.say("something more expensive", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "pricier" }) })).outcome);
  assert.equal(q(m.groups[0]).priceMax, null);
  assert.equal(q(m.groups[0]).priceMin, Math.round((top + 0.01) * 100) / 100);
  assert.ok((m.groups[0]?.products.length ?? 0) > 0 && m.groups[0]?.products.every((p) => p.price > top));
});

test("a new bound that contradicts the old one replaces it: 'over $500' after 'under $200' is over $500", async () => {
  const h = harness();
  await h.say("a gift for my wife under $200", { router: routerResult(), extract: gift200() });
  const m = done((await h.say("show me gifts over $500", { router: routerResult({ act: "refine" }), extract: search({ gift: true, priceMin: 500, currency: "USD" }) })).outcome);
  assert.deepEqual([q(m.groups[0]).priceMin, q(m.groups[0]).priceMax], [500, null]);
  assert.ok(m.groups[0]?.products.every((p) => p.price >= 500));
});

test("with nothing on screen, 'more expensive' is measured from the old limit: laptops under $1000 found none", async () => {
  const h = harness();
  const miss = done((await h.say("laptops under $1000", { router: routerResult(), extract: search({ category: "laptops", noun: "laptop", priceMax: 1000, currency: "USD" }) })).outcome);
  assert.equal(miss.groups[0]?.status, "miss");
  const m = done((await h.say("more expensive ones", { router: routerResult({ act: "refine" }), extract: search({ relativePrice: "pricier" }) })).outcome);
  assert.deepEqual([q(m.groups[0]).priceMin, q(m.groups[0]).priceMax], [1000.01, null]);
  assert.equal(m.groups[0]?.status, "results");
});

test("'something else, more expensive' rejects what is shown and replaces the budget the same way", async () => {
  const h = harness();
  const first = done((await h.say("a gift for my wife under $100", { router: routerResult(), extract: search({ gift: true, attributes: ["women"], priceMax: 100, currency: "USD" }) })).outcome);
  const top = dearest(first);
  const m = done((await h.say("something else, more expensive", { router: routerResult({ act: "reject" }), extract: search({ relativePrice: "pricier" }) })).outcome);
  assert.equal(q(m.groups[0]).priceMax, null);
  assert.ok(m.groups[0]?.products.every((p) => p.price > top));
});

test("a message that says nothing about price keeps the range: 'not jewelry' after 'under $100' is still under $100", async () => {
  const h = harness();
  await h.say("a gift for my wife under $100", { router: routerResult(), extract: search({ gift: true, attributes: ["women"], priceMax: 100, currency: "USD" }) });
  const m = done((await h.say("not jewelry", { router: routerResult({ act: "reject" }), extract: search({}) })).outcome);
  assert.equal(q(m.groups[0]).priceMax, 100);
});

test("a gift's categories follow its recipient: 'for my mom' after 'for my dad' is her gift set, not his", async () => {
  const h = harness();
  await h.say("a gift for my dad up to $100", { router: routerResult(), extract: search({ gift: true, attributes: ["men"], priceMax: 100, currency: "USD" }) });
  const m = done((await h.say("actually it's for my mom", { router: routerResult({ act: "refine" }), extract: search({ gift: true, attributes: ["women"] }) })).outcome);
  assert.equal(q(m.groups[0]).gender, "womens");
  assert.deepEqual(q(m.groups[0]).within, giftCategories({ kid: false, gender: "womens", theme: null }));
  assert.ok(m.groups[0]?.products.every((p) => !p.category.startsWith("mens-") && p.category !== "mobile-accessories"));
});

test("a recipient carried over from a gift question never empties a search: 'a dress for myself' after 'a gift for my dad'", async () => {
  const h = harness();
  await h.say("a gift for my dad", { router: routerResult(), extract: search({ gift: true, attributes: ["men"] }) });
  const m = done((await h.say("actually I need a dress for myself", { router: routerResult(), extract: search({ noun: "dress", category: "tops" }) })).outcome);
  assert.equal(m.groups[0]?.status, "results");
  assert.equal(q(m.groups[0]).gender, null);
});
