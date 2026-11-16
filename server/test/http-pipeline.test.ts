// HTTP through the real turn runner (not http.test.ts's echo runner): the outcome-to-status mapping,
// resend idempotency, and the progress endpoint, over the recorded catalog with scripted models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { createCategoryNames } from "../src/catalog/cache.ts";
import { createTurnRunner } from "../src/pipeline/runTurn.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import { createFixtureApi } from "./fakes/catalog.ts";
import { createScriptedModels } from "./fakes/scripted.ts";

function setup() {
  const { db, warning } = openDatabase(join(mkdtempSync(join(tmpdir(), "http-pipeline-")), "c.sqlite"));
  const store = createStore(db, { warning });
  const api = createFixtureApi();
  const { router, slots } = createScriptedModels({ slowMs: 150 });
  const runner = createTurnRunner({
    store, router, slots,
    retriever: createRetriever(api),
    categories: createCategoryNames(api, { ttlMs: 3_600_000, now: Date.now }),
    catalog: api,
    writer: { write: async () => null },
  });
  return buildApp({ store, runner, warning });
}

type App = ReturnType<typeof setup>;
const post = (app: App, url: string, body: object) => app.inject({ method: "POST", url, payload: body });
const get = (app: App, url: string) => app.inject({ method: "GET", url });

test("a new chat and a follow-up: 200s with cards then a detail, stored and traced", async () => {
  const app = setup();
  const first = await post(app, "/api/conversations", { messageId: randomUUID(), text: "cheap sunglasses" });
  assert.equal(first.statusCode, 200);
  const a = first.json();
  assert.equal(a.assistantMessage.groups[0].products.length, 4);

  const followId = randomUUID();
  const follow = await post(app, `/api/conversations/${a.conversationId}/messages`, {
    messageId: followId, text: "tell me about the first one", revision: a.revision,
  });
  assert.equal(follow.statusCode, 200);
  assert.equal(follow.json().assistantMessage.detail.id, a.assistantMessage.groups[0].products[0].id);

  const conv = (await get(app, `/api/conversations/${a.conversationId}`)).json();
  assert.equal(conv.messages.length, 4);
  const trace = (await get(app, `/api/messages/${followId}/trace`)).json();
  assert.equal(trace.traces[0].outcome, "completed");
});

test("a failed turn is 503 retryable; resending the same message is 200 with one user message", async () => {
  const app = setup();
  const messageId = randomUUID();
  const failed = await post(app, "/api/conversations", { messageId, text: "fail once" });
  assert.equal(failed.statusCode, 503);
  const body = failed.json();
  assert.equal(body.error.code, "reply_failed");
  assert.equal(body.retryable, true);

  const retried = await post(app, "/api/conversations", { messageId, text: "fail once" });
  assert.equal(retried.statusCode, 200);
  // A third send of an answered message replays the stored reply without running the pipeline.
  const replay = await post(app, "/api/conversations", { messageId, text: "fail once" });
  assert.deepEqual(replay.json().assistantMessage, retried.json().assistantMessage);

  const conv = (await get(app, `/api/conversations/${body.conversationId}`)).json();
  assert.deepEqual(conv.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
});

test("progress shows the stage mid-turn, and a resend in flight joins the same run", async () => {
  const app = setup();
  const messageId = randomUUID();
  const one = post(app, "/api/conversations", { messageId, text: "slow laptops" });
  // Let the request reach the router, which the script holds for slowMs.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await get(app, `/api/messages/${messageId}/progress`)).json().stage, "classifying");
  const two = post(app, "/api/conversations", { messageId, text: "slow laptops" });
  const [r1, r2] = await Promise.all([one, two]);
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r1.json().assistantMessage.id, r2.json().assistantMessage.id);
  assert.equal((await get(app, `/api/messages/${messageId}/progress`)).json().stage, "idle");
});
