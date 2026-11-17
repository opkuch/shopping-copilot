import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/store/db.ts";
import { createStore } from "../src/store/conversations.ts";
import { buildApp } from "../src/app.ts";
import type { Store, TurnOutcome, TurnRunner } from "../src/pipeline/ports.ts";
import { createRateLimiter } from "../src/web/rateLimit.ts";
import type { RateLimiter } from "../src/web/rateLimit.ts";
import type { Stage } from "../src/messages/schema.ts";

type Mode = "complete" | "reply_failed" | "gone" | "not_tail";

function setup(opts: { warning?: string | null; limiter?: RateLimiter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "http-"));
  const opened = openDatabase(join(dir, "c.sqlite"));
  const store: Store = createStore(opened.db, { warning: opened.warning });
  const state = { mode: "complete" as Mode, gate: null as Promise<void> | null, calls: 0, stage: "idle" as Stage };
  // Like the real runner: a second run for the same message joins the first.
  const inflight = new Map<string, Promise<TurnOutcome>>();
  const runner: TurnRunner = {
    run(args) {
      state.calls++;
      const existing = inflight.get(args.userMessage.id);
      if (existing) return existing;
      const p = work(args).finally(() => inflight.delete(args.userMessage.id));
      inflight.set(args.userMessage.id, p);
      return p;
    },
    stage: () => state.stage,
    preview: () => null,
  };
  async function work({ conversationId, userMessage }: Parameters<TurnRunner["run"]>[0]): Promise<TurnOutcome> {
    if (state.gate) await state.gate;
    if (state.mode === "reply_failed") {
      return { kind: "reply_failed", conversationId, revision: store.getConversation(conversationId)?.revision ?? 0, userMessageId: userMessage.id };
    }
    if (state.mode === "gone") return { kind: "dropped", reason: "conversation_gone" };
    if (state.mode === "not_tail") return { kind: "dropped", reason: "not_tail" };
    const stored = store.storeAssistant({
      conversationId, userMessageId: userMessage.id, text: `echo ${userMessage.text}`,
      payload: null, trace: { attempt: store.nextAttempt(userMessage.id), trace: {} },
    });
    if (stored.kind !== "stored") return { kind: "dropped", reason: stored.reason };
    const conv = store.getConversation(conversationId);
    return {
      kind: "completed",
      response: {
        conversationId, revision: conv?.revision ?? 0,
        userMessage: { id: userMessage.id, role: "user", text: userMessage.text, createdAt: userMessage.createdAt },
        assistantMessage: stored.assistantMessage,
      },
    };
  }
  const app = buildApp({ store, runner, warning: opts.warning ?? null, ...(opts.limiter ? { limiter: opts.limiter } : {}) });
  return { app, store, state };
}

type App = ReturnType<typeof setup>["app"];
const post = (app: App, url: string, body: unknown) =>
  app.inject({ method: "POST", url, payload: body as object });

async function create(app: App, text = "hi") {
  const messageId = randomUUID();
  const res = await post(app, "/api/conversations", { messageId, text });
  return { messageId, res, body: res.json() };
}

test("create runs a turn and returns 200", async () => {
  const { app } = setup();
  const { res, body } = await create(app);
  assert.equal(res.statusCode, 200);
  assert.equal(body.revision, 1);
  assert.equal(body.assistantMessage.text, "echo hi");
});

test("two clients on the same revision: one 200, one 409 with the winning transcript", async () => {
  const { app, state } = setup();
  const { body: first } = await create(app);
  let release!: () => void;
  state.gate = new Promise((r) => (release = r));
  const mk = (text: string) =>
    post(app, `/api/conversations/${first.conversationId}/messages`, { messageId: randomUUID(), text, revision: first.revision });
  const a = mk("from A");
  const b = mk("from B");
  // The loser is rejected at accept time, before the gate opens.
  const settled = await Promise.race([a.then((r) => ({ r, w: "a" })), b.then((r) => ({ r, w: "b" }))]);
  assert.equal(settled.r.statusCode, 409);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  const codes = [ra.statusCode, rb.statusCode].sort();
  assert.deepEqual(codes, [200, 409]);
  const loser = ra.statusCode === 409 ? ra : rb;
  const winner = ra.statusCode === 200 ? ra : rb;
  const err = loser.json();
  assert.equal(err.error.code, "revision_conflict");
  const winnerText = winner.json().userMessage.text;
  assert.ok(err.conversation.messages.some((m: { text: string }) => m.text === winnerText));
  assert.equal(err.conversation.revision, 2);
});

test("503 reply_failed carries everything needed to resend", async () => {
  const { app, state } = setup();
  state.mode = "reply_failed";
  const { res, body, messageId } = await create(app);
  assert.equal(res.statusCode, 503);
  assert.equal(body.error.code, "reply_failed");
  assert.equal(body.userMessageId, messageId);
  assert.equal(body.revision, 1);
  assert.equal(body.retryable, true);
  assert.ok(body.conversationId);
  // Retry: same body resolves to the same conversation without a new row.
  state.mode = "complete";
  const retry = await post(app, "/api/conversations", { messageId, text: "hi" });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().conversationId, body.conversationId);
  assert.equal(retry.json().revision, 1);
});

test("resend after a dropped response returns the same reply without calling the runner", async () => {
  const { app, state } = setup();
  const { messageId, body } = await create(app);
  assert.equal(state.calls, 1);
  const again = await post(app, "/api/conversations", { messageId, text: "hi" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().assistantMessage.id, body.assistantMessage.id);
  const again2 = await post(app, `/api/conversations/${body.conversationId}/messages`, { messageId, text: "hi", revision: 0 });
  assert.equal(again2.statusCode, 200);
  assert.equal(again2.json().assistantMessage.id, body.assistantMessage.id);
  assert.equal(state.calls, 1);
});

test("resend while in flight goes to the runner, which owns dedup", async () => {
  const { app, state } = setup();
  let release!: () => void;
  state.gate = new Promise((r) => (release = r));
  const messageId = randomUUID();
  const a = post(app, "/api/conversations", { messageId, text: "slow" });
  await new Promise((r) => setTimeout(r, 20));
  const b = post(app, "/api/conversations", { messageId, text: "slow" });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(state.calls, 2);
  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 200);
  assert.equal(ra.json().assistantMessage.id, rb.json().assistantMessage.id);
});

test("resend of an unanswered message that is no longer the tail is 409", async () => {
  const { app, state } = setup();
  state.mode = "reply_failed";
  const { body } = await create(app, "one");
  const firstId = body.userMessageId as string;
  state.mode = "complete";
  const second = await post(app, `/api/conversations/${body.conversationId}/messages`, { messageId: randomUUID(), text: "two", revision: 1 });
  assert.equal(second.statusCode, 200);
  const resend = await post(app, `/api/conversations/${body.conversationId}/messages`, { messageId: firstId, text: "one", revision: 1 });
  // "one" never got a reply but "two" followed it.
  assert.equal(resend.statusCode, 409);
  assert.equal(resend.json().error.code, "revision_conflict");
  assert.equal(resend.json().conversation.id, body.conversationId);
});

test("dropped outcomes map to 404 and 409", async () => {
  const { app, state } = setup();
  const { body } = await create(app);
  state.mode = "gone";
  const g = await post(app, `/api/conversations/${body.conversationId}/messages`, { messageId: randomUUID(), text: "x", revision: 1 });
  assert.equal(g.statusCode, 404);
  state.mode = "not_tail";
  const n = await post(app, `/api/conversations/${body.conversationId}/messages`, { messageId: randomUUID(), text: "y", revision: 2 });
  assert.equal(n.statusCode, 409);
  assert.equal(n.json().conversation.id, body.conversationId);
});

test("reused messageId with different text is 400", async () => {
  const { app } = setup();
  const { messageId } = await create(app, "original");
  const res = await post(app, "/api/conversations", { messageId, text: "different" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "validation");
});

test("invalid bodies are 400 validation and store nothing", async () => {
  const { app, store, state } = setup();
  const bad: unknown[] = [
    { messageId: randomUUID(), text: "   " },
    { messageId: randomUUID(), text: "x".repeat(2001) },
    { messageId: "not-a-uuid", text: "hi" },
    { text: "hi" },
  ];
  for (const b of bad) {
    const res = await post(app, "/api/conversations", b);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "validation");
  }
  const malformed = await app.inject({
    method: "POST", url: "/api/conversations",
    headers: { "content-type": "application/json" }, payload: "{not json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "validation");
  // too large and not JSON keep their own status, still with the validation code
  const huge = await post(app, "/api/conversations", { messageId: randomUUID(), text: "x".repeat(20_000) });
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.json().error.code, "validation");
  const form = await app.inject({ method: "POST", url: "/api/conversations", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "text=hi" });
  assert.equal(form.statusCode, 415);
  assert.equal(form.json().error.code, "validation");
  assert.deepEqual(store.listConversations().conversations, []);
  assert.equal(state.calls, 0);

  const ok = await create(app);
  const stale = await post(app, `/api/conversations/${ok.body.conversationId}/messages`, { messageId: randomUUID(), text: "hi" });
  assert.equal(stale.statusCode, 400);
  assert.equal(store.getConversation(ok.body.conversationId)?.messages.length, 2);
});

test("unknown conversation is 404 on GET and POST", async () => {
  const { app } = setup();
  const id = randomUUID();
  const g = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
  assert.equal(g.statusCode, 404);
  assert.equal(g.json().error.code, "not_found");
  const p = await post(app, `/api/conversations/${id}/messages`, { messageId: randomUUID(), text: "hi", revision: 0 });
  assert.equal(p.statusCode, 404);
});

test("GET conversation returns the transcript", async () => {
  const { app } = setup();
  const { body } = await create(app);
  const res = await app.inject({ method: "GET", url: `/api/conversations/${body.conversationId}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().messages.length, 2);
});

test("progress returns the runner stage; trace is 404 for an unknown message", async () => {
  const { app, state } = setup();
  state.stage = "searching";
  const p = await app.inject({ method: "GET", url: `/api/messages/${randomUUID()}/progress` });
  assert.deepEqual(p.json(), { stage: "searching", preview: null });
  const t = await app.inject({ method: "GET", url: `/api/messages/${randomUUID()}/trace` });
  assert.equal(t.statusCode, 404);
  const { body } = await create(app);
  const t2 = await app.inject({ method: "GET", url: `/api/messages/${body.userMessage.id}/trace` });
  assert.equal(t2.statusCode, 200);
  assert.equal(t2.json().traces.length, 1);
});

test("paths outside /api are 404 so a future SPA can own them", async () => {
  const { app } = setup();
  for (const url of ["/c/anything", "/conversations", "/", "/api/nope"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
  }
});

test("list includes the warning from deps", async () => {
  const none = setup();
  assert.deepEqual((await none.app.inject({ method: "GET", url: "/api/conversations" })).json(), { conversations: [], warning: null });
  const warned = setup({ warning: "previous_history_unreadable" });
  const res = await warned.app.inject({ method: "GET", url: "/api/conversations" });
  assert.equal(res.json().warning, "previous_history_unreadable");
});

test("an unexpected throw after the save is 500 internal, not storage_failed", async () => {
  const { app, store } = setup();
  const origError = console.error;
  console.error = () => {};
  try {
    const { body } = await create(app);
    store.getConversation = () => { throw new Error("boom"); };
    const res = await app.inject({ method: "GET", url: `/api/conversations/${body.conversationId}` });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error.code, "internal");
  } finally {
    console.error = origError;
  }
});

test("an accept that throws is 500 storage_failed", async () => {
  const { app, store } = setup();
  const origError = console.error;
  console.error = () => {};
  try {
    store.acceptFirst = () => { throw new Error("disk full"); };
    const res = await post(app, "/api/conversations", { messageId: randomUUID(), text: "hi" });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error.code, "storage_failed");
  } finally {
    console.error = origError;
  }
});

test("too many new turns in a minute: 429 with retry-after, nothing stored; a resend of an accepted message is not counted", async () => {
  let now = 0;
  // The creating message counts under "new" (no conversation yet); one more is allowed in the conversation.
  const { app, store } = setup({ limiter: createRateLimiter({ perConversation: 1, total: 100, now: () => now }) });
  const first = await create(app, "one");
  const id = first.body.conversationId as string;
  let revision = first.body.revision as number;
  const second = await post(app, `/api/conversations/${id}/messages`, { messageId: randomUUID(), text: "two", revision });
  assert.equal(second.statusCode, 200);
  revision = second.json().revision;
  // a resend of the accepted second message is free
  const resend = await post(app, `/api/conversations/${id}/messages`, { messageId: second.json().userMessage.id, text: "two", revision });
  assert.equal(resend.statusCode, 200);
  const third = await post(app, `/api/conversations/${id}/messages`, { messageId: randomUUID(), text: "three", revision });
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, "rate_limited");
  assert.ok(Number(third.headers["retry-after"]) >= 1);
  assert.equal(store.getConversation(id)?.messages.filter((m) => m.role === "user").length, 2, "the refused message is not stored");
  now += 60_000;
  const later = await post(app, `/api/conversations/${id}/messages`, { messageId: randomUUID(), text: "three", revision });
  assert.equal(later.statusCode, 200);
});

test("a resend that would run the models again (its run failed) counts against the limit", async () => {
  let now = 0;
  const { app, state } = setup({ limiter: createRateLimiter({ perConversation: 100, total: 1, now: () => now }) });
  state.mode = "reply_failed";
  const failed = await create(app, "one");
  assert.equal(failed.res.statusCode, 503);
  // the limit allows one model run a minute: the retry would be the second
  state.mode = "complete";
  const retry = await post(app, "/api/conversations", { messageId: failed.messageId, text: "one" });
  assert.equal(retry.statusCode, 429);
  now += 60_000;
  const later = await post(app, "/api/conversations", { messageId: failed.messageId, text: "one" });
  assert.equal(later.statusCode, 200);
  // once answered, resending it costs nothing and is never refused
  assert.equal((await post(app, "/api/conversations", { messageId: failed.messageId, text: "one" })).statusCode, 200);
});

test("a new message while another message's reply is still running (a second tab): 409, and that reply is kept", async () => {
  const { app, state, store } = setup();
  const { body: first } = await create(app);
  let release!: () => void;
  state.gate = new Promise((r) => (release = r));
  state.stage = "searching";
  const a = post(app, `/api/conversations/${first.conversationId}/messages`, { messageId: randomUUID(), text: "from A", revision: first.revision });
  await new Promise((r) => setTimeout(r, 20));
  // B saw A's message (revision 2) but not its reply
  const b = await post(app, `/api/conversations/${first.conversationId}/messages`, { messageId: randomUUID(), text: "from B", revision: 2 });
  assert.equal(b.statusCode, 409);
  assert.equal(b.json().error.code, "revision_conflict");
  state.stage = "idle";
  release();
  assert.equal((await a).statusCode, 200);
  const roles = store.getConversation(first.conversationId)?.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"], "no two questions in a row, A's reply stored");
});
