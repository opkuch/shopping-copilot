// Locks what each scripted row produces through the real orchestrator over the recorded catalog,
// so a fixture or pipeline change fails here before it fails the browser test (web/e2e).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCategoryNames } from "../src/catalog/cache.ts";
import type { TurnResponse } from "../src/messages/schema.ts";
import { createTurnRunner } from "../src/pipeline/runTurn.ts";
import type { AcceptResult, TurnOutcome } from "../src/pipeline/ports.ts";
import * as T from "../src/reply/templates.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import { createFixtureApi } from "./fakes/catalog.ts";
import { createScriptedModels, SCRIPT } from "./fakes/scripted.ts";

function setup() {
  const { db, warning } = openDatabase(join(mkdtempSync(join(tmpdir(), "scripted-")), "c.sqlite"));
  const store = createStore(db, { warning });
  const api = createFixtureApi();
  const { router, slots } = createScriptedModels({ slowMs: 5 });
  const runner = createTurnRunner({
    store, router, slots,
    retriever: createRetriever(api),
    categories: createCategoryNames(api, { ttlMs: 3_600_000, now: Date.now }),
    catalog: api,
    writer: { write: async () => null },
  });

  const run = (accepted: AcceptResult): Promise<TurnOutcome> => {
    assert.equal(accepted.kind, "accepted");
    if (accepted.kind !== "accepted") throw new Error("not accepted");
    return runner.run(accepted);
  };
  const completed = (outcome: TurnOutcome): TurnResponse => {
    if (outcome.kind !== "completed") throw new Error(`expected completed, got ${outcome.kind}`);
    return outcome.response;
  };
  return {
    store,
    runner,
    first: async (text: string) => completed(await run(store.acceptFirst(randomUUID(), text))),
    next: async (prev: TurnResponse, text: string) =>
      completed(await run(store.acceptMessage(prev.conversationId, randomUUID(), text, prev.revision))),
    run,
  };
}

test("cheap sunglasses: four cards, lowest price first", async () => {
  const { first } = setup();
  const res = await first("cheap sunglasses");
  const [group] = res.assistantMessage.groups;
  assert.equal(res.assistantMessage.groups.length, 1);
  assert.equal(group?.status, "results");
  assert.equal(group?.products.length, 4);
  const prices = group!.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});

test("a laptop and a fragrance under 50: two groups, every fragrance at or under $50", async () => {
  const { first } = setup();
  const res = await first("A laptop and a fragrance under 50");
  const [laptops, fragrances] = res.assistantMessage.groups;
  assert.equal(res.assistantMessage.groups.length, 2);
  assert.equal(laptops?.status, "results");
  assert.ok(laptops!.products.length > 0);
  assert.ok(laptops!.products.every((p) => p.category === "laptops"));
  assert.equal(fragrances?.status, "results");
  assert.ok(fragrances!.products.length > 0);
  assert.ok(fragrances!.products.every((p) => p.category === "fragrances" && p.price <= 50));
});

test("tell me about the first one: a live detail for the first card shown", async () => {
  const { first, next } = setup();
  const search = await first("cheap sunglasses");
  const res = await next(search, "tell me about the first one");
  const firstCard = search.assistantMessage.groups[0]!.products[0]!;
  assert.deepEqual(res.assistantMessage.groups, []);
  assert.equal(res.assistantMessage.detail?.id, firstCard.id);
  assert.equal(res.assistantMessage.detail?.source, "live");
  assert.ok(res.assistantMessage.detail!.description.length >= firstCard.description.replace(/…$/, "").length);
});

test("a flight to tokyo: no groups, the service template", async () => {
  const { first } = setup();
  const res = await first("a flight to tokyo");
  assert.deepEqual(res.assistantMessage.groups, []);
  assert.equal(res.assistantMessage.text, T.service());
});

test("fail once: the first run fails, the resend of the same message succeeds", async () => {
  const { store, runner, run } = setup();
  const messageId = randomUUID();
  const failed = await run(store.acceptFirst(messageId, "fail once"));
  assert.equal(failed.kind, "reply_failed");
  const state = store.resendState(messageId);
  assert.equal(state?.kind, "unanswered_tail");
  if (state?.kind !== "unanswered_tail") return;
  const retried = await runner.run(state);
  assert.equal(retried.kind, "completed");
  if (retried.kind !== "completed") return;
  assert.ok(retried.response.assistantMessage.groups[0]!.products.length > 0);
  // One user message, one reply.
  assert.equal(store.getConversation(retried.response.conversationId)?.messages.length, 2);
});

test("slow laptops: answers after the delay with laptops", async () => {
  const { first } = setup();
  const res = await first("slow laptops");
  assert.ok(res.assistantMessage.groups[0]!.products.every((p) => p.category === "laptops"));
});

test("an utterance outside the table gets the greeting", async () => {
  const { first } = setup();
  const res = await first("hello there");
  assert.deepEqual(res.assistantMessage.groups, []);
  assert.equal(res.assistantMessage.text, T.greeting());
});

test("every table key is already normalized", () => {
  for (const key of Object.keys(SCRIPT)) assert.equal(key, key.trim().toLowerCase().replace(/\s+/g, " "));
});
