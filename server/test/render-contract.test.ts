// Rendering contract: the JSON a real turn returns is what the UI will render.
// No browser, no CSS; this locks the fields a card needs and the shape of miss and refer messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCategoryNames } from "../src/catalog/cache.ts";
import { AssistantMessage } from "../src/messages/schema.ts";
import type { ExtractionResult, RouterResult } from "../src/messages/schema.ts";
import { createTurnRunner } from "../src/pipeline/runTurn.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import { createFixtureApi } from "./fakes/catalog.ts";
import { createFakeRouter, createFakeSlots, createFakeWriter, extraction, intent, routerResult } from "./fakes/models.ts";

function setup() {
  const opened = openDatabase(join(mkdtempSync(join(tmpdir(), "render-")), "c.sqlite"));
  const store = createStore(opened.db, { warning: opened.warning });
  const api = createFixtureApi();
  const router = createFakeRouter();
  const slots = createFakeSlots();
  const writer = createFakeWriter();
  const runner = createTurnRunner({
    store, router, slots, writer, catalog: api, retriever: createRetriever(api),
    categories: createCategoryNames(api, { ttlMs: 3_600_000, now: Date.now }),
  });
  let conversationId: string | null = null;
  let revision = 0;
  // Returns the assistant message exactly as the HTTP layer would serialize it.
  async function turn(text: string, r: RouterResult, e: ExtractionResult | null = null) {
    const id = randomUUID();
    const accepted = conversationId === null ? store.acceptFirst(id, text) : store.acceptMessage(conversationId, id, text, revision);
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind !== "accepted") throw new Error("unreachable");
    conversationId = accepted.conversationId;
    revision = accepted.revision;
    router.queue(r);
    slots.queue(e ?? { refused: true });
    writer.queue(null);
    const outcome = await runner.run({ conversationId, revision, userMessage: accepted.userMessage });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") throw new Error("unreachable");
    return JSON.parse(JSON.stringify(outcome.response.assistantMessage)) as unknown;
  }
  return { turn };
}

const search = (...i: Parameters<typeof intent>[0][]) => extraction(i.map((x) => intent(x)));

test("a results message validates against AssistantMessage and every card has what the UI renders", async () => {
  const { turn } = setup();
  const raw = await turn("a laptop and a fragrance", routerResult(), search({ category: "laptops" }, { category: "fragrances" }));
  const m = AssistantMessage.parse(raw);
  assert.equal(m.unreadable, false);
  assert.equal(m.detail, null);
  assert.equal(m.groups.length, 2);
  for (const g of m.groups) {
    assert.equal(g.status, "results");
    assert.ok(g.label.length > 0);
    assert.ok(g.products.length > 0 && g.products.length <= 4);
    for (const p of g.products) {
      assert.ok(p.title.length > 0);
      assert.ok(p.description.length > 0 && p.description.length <= 160);
      assert.ok(p.thumbnail.length > 0);
      assert.equal(typeof p.price, "number");
      assert.equal(typeof p.inStock, "boolean");
    }
  }
});

test("out-of-stock cards are present with inStock false, ranked after in-stock ones", async () => {
  const { turn } = setup();
  const m = AssistantMessage.parse(await turn("everything", routerResult(), search({ attributes: ["a"], sort: "relevance" })));
  const flags = m.groups[0]?.products.map((p) => p.inStock) ?? [];
  assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)));
});

test("a miss group has no cards and still validates", async () => {
  const { turn } = setup();
  const m = AssistantMessage.parse(await turn("a unicorn", routerResult(), search({ noun: "unicorn" })));
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0]?.status, "miss");
  assert.deepEqual(m.groups[0]?.products, []);
  assert.equal(m.groups[0]?.total, 0);
  assert.equal(m.groups[0]?.match, "none");
  assert.ok(m.text.length > 0);
});

test("an unavailable-free partial result still validates: miss next to results", async () => {
  const { turn } = setup();
  const m = AssistantMessage.parse(await turn("laptop and unicorn", routerResult(), search({ category: "laptops" }, { noun: "unicorn" })));
  assert.deepEqual(m.groups.map((g) => g.status), ["results", "miss"]);
  assert.deepEqual(m.groups[1]?.products, []);
});

test("a refer message has a detail block and no groups", async () => {
  const { turn } = setup();
  await turn("laptops", routerResult(), search({ category: "laptops" }));
  const m = AssistantMessage.parse(await turn("tell me about the first", routerResult({ act: "refer", referTarget: 1 })));
  assert.deepEqual(m.groups, []);
  assert.ok(m.detail);
  assert.equal(m.detail?.source, "live");
  assert.ok((m.detail?.description.length ?? 0) > 0);
  assert.equal(typeof m.detail?.price, "number");
  assert.equal(typeof m.detail?.inStock, "boolean");
});

test("template-only messages (chat, refusal) validate with no groups and no detail", async () => {
  const { turn } = setup();
  const chat = AssistantMessage.parse(await turn("hi", routerResult({ act: "chat" })));
  const refused = AssistantMessage.parse(await turn("no", routerResult({ refused: true })));
  for (const m of [chat, refused]) {
    assert.deepEqual(m.groups, []);
    assert.equal(m.detail, null);
    assert.ok(m.text.length > 0);
  }
});
