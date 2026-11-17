import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, MIGRATIONS } from "../src/store/db.ts";
import { createStore } from "../src/store/conversations.ts";
import { withTransaction } from "../src/store/tx.ts";
import type { Group, Payload } from "../src/messages/schema.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "store-")), "sub", "c.sqlite");
}

let tick = 0;
function setup() {
  const path = tmpPath();
  const opened = openDatabase(path);
  const now = () => new Date(Date.UTC(2026, 10, 14, 12, 0, tick++));
  const store = createStore(opened.db, { warning: opened.warning, now });
  return { path, ...opened, store };
}

const group: Group = {
  label: "shoes", status: "results", match: "exact",
  query: { category: null, noun: "shoes", attributes: [], priceMin: null, priceMax: null, sort: "relevance", inStock: false, gender: null, categoryStated: false, top: false, within: null, purpose: null, exclude: [], offset: 0 },
  products: [], total: 0,
};
const payload: Payload = { groups: [group], detail: null };

function first(s: ReturnType<typeof setup>, text = "hello") {
  const id = randomUUID();
  const r = s.store.acceptFirst(id, text);
  assert.equal(r.kind, "accepted");
  if (r.kind !== "accepted") throw new Error("unreachable");
  return { id, conversationId: r.conversationId };
}
function answer(s: ReturnType<typeof setup>, conversationId: string, userMessageId: string, p: Payload | null = payload) {
  return s.store.storeAssistant({ conversationId, userMessageId, text: "ok", payload: p, trace: { attempt: 1, trace: { a: 1 } } });
}

test("user message survives when no assistant is stored", () => {
  const s = setup();
  const { conversationId } = first(s);
  const v = s.store.getConversation(conversationId);
  assert.equal(v?.messages.length, 1);
  assert.equal(v?.revision, 1);
});

test("payload and trace commit together or not at all", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  // Pre-insert a trace with the id the store will generate so the second insert fails.
  const store = createStore(s.db, { warning: null, newId: () => "fixed" });
  s.db.prepare("INSERT INTO turn_traces VALUES ('fixed', ?, 1, 'x', '{}', 't')").run(id);
  assert.throws(() => store.storeAssistant({ conversationId, userMessageId: id, text: "t", payload, trace: { attempt: 2, trace: {} } }));
  assert.equal(s.store.getConversation(conversationId)?.messages.length, 1);
  assert.equal(s.store.traces(id).length, 1);
});

test("stale revision conflicts with the current transcript", () => {
  const s = setup();
  const { conversationId } = first(s);
  const r = s.store.acceptMessage(conversationId, randomUUID(), "again", 0);
  assert.equal(r.kind, "conflict");
  if (r.kind === "conflict") {
    assert.equal(r.conversation.revision, 1);
    assert.equal(r.conversation.messages.length, 1);
  }
  assert.equal(s.store.acceptMessage("nope", randomUUID(), "x", 0).kind, "not_found");
});

test("idempotent resend returns exists and does not bump revision", () => {
  const s = setup();
  const { id, conversationId } = first(s, "hi");
  const again = s.store.acceptFirst(id, "hi");
  assert.deepEqual(again, { kind: "exists", conversationId, messageId: id });
  const m = randomUUID();
  assert.equal(s.store.acceptMessage(conversationId, m, "two", 1).kind, "accepted");
  assert.equal(s.store.acceptMessage(conversationId, m, "two", 1).kind, "exists");
  assert.equal(s.store.getConversation(conversationId)?.revision, 2);
});

test("reused id with different text is text_mismatch", () => {
  const s = setup();
  const { id, conversationId } = first(s, "hi");
  assert.equal(s.store.acceptFirst(id, "other").kind, "text_mismatch");
  assert.equal(s.store.acceptMessage(conversationId, id, "other", 1).kind, "text_mismatch");
  const second = first(s, "elsewhere");
  assert.equal(s.store.acceptMessage(second.conversationId, id, "hi", 1).kind, "text_mismatch");
});

test("late assistant after a newer user message is dropped", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  s.store.acceptMessage(conversationId, randomUUID(), "newer", 1);
  assert.deepEqual(answer(s, conversationId, id), { kind: "dropped", reason: "not_tail" });
  assert.deepEqual(answer(s, "gone", id), { kind: "dropped", reason: "conversation_gone" });
  assert.equal(s.store.getConversation(conversationId)?.messages.length, 2);
});

test("resendState: answered, unanswered_tail, not_tail", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  assert.equal(s.store.resendState(id)?.kind, "unanswered_tail");
  assert.equal(s.store.resendState("unknown"), null);
  const stored = answer(s, conversationId, id);
  assert.equal(stored.kind, "stored");
  const st = s.store.resendState(id);
  assert.equal(st?.kind, "answered");
  assert.equal(s.store.getConversation(conversationId)?.revision, 1);
  const m2 = randomUUID();
  s.store.acceptMessage(conversationId, m2, "next", 1);
  assert.equal(s.store.resendState(id)?.kind, "answered");
  const m3 = randomUUID();
  s.store.acceptMessage(conversationId, m3, "third", 2);
  assert.equal(s.store.resendState(m2)?.kind, "not_tail");
  assert.equal(s.store.resendState(m3)?.kind, "unanswered_tail");
});

test("corrupt payload loads as unreadable; workingQuery returns null", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  const r = answer(s, conversationId, id);
  assert.equal(s.store.workingQuery(conversationId)?.groups.length, 1);
  if (r.kind !== "stored") throw new Error("unreachable");
  s.db.prepare("UPDATE messages SET payload_json = '{bad' WHERE id = ?").run(r.assistantMessage.id);
  const v = s.store.getConversation(conversationId);
  assert.equal(v?.messages.length, 2);
  const a = v?.messages[1];
  assert.ok(a && a.role === "assistant");
  assert.equal(a.unreadable, true);
  assert.deepEqual(a.groups, []);
  assert.equal(a.detail, null);
  assert.equal(v?.messages[0]?.role, "user");
  assert.equal(s.store.workingQuery(conversationId), null);
});

test("refer-style payload with no groups is skipped by workingQuery", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  const a1 = answer(s, conversationId, id);
  const m2 = randomUUID();
  s.store.acceptMessage(conversationId, m2, "tell me about #1", 1);
  const detail = {
    id: 1, title: "t", description: "d", price: 1, thumbnail: "x", rating: 1, category: "c", inStock: true,
    brand: null, availabilityStatus: null, warrantyInformation: null, shippingInformation: null,
    returnPolicy: null, reviewCount: null, source: "live" as const,
  };
  answer(s, conversationId, m2, { groups: [], detail });
  const w = s.store.workingQuery(conversationId);
  assert.equal(w?.messageId, a1.kind === "stored" ? a1.assistantMessage.id : "");
});

test("text-only assistant message has null payload and is readable", () => {
  const s = setup();
  const { id, conversationId } = first(s);
  answer(s, conversationId, id, null);
  const a = s.store.getConversation(conversationId)?.messages[1];
  assert.ok(a && a.role === "assistant");
  assert.equal(a.unreadable, false);
  assert.equal(s.store.workingQuery(conversationId), null);
});

test("corrupt database file is moved aside with sidecars; second recovery keeps the first", () => {
  const path = tmpPath();
  const fixed = () => new Date(Date.UTC(2026, 10, 14, 12, 0, 0, 0));
  const dir = join(path, "..");
  const corrupt = () => {
    writeFileSync(path, Buffer.from("this is definitely not sqlite ".repeat(200)));
    writeFileSync(path + "-wal", "wal");
    writeFileSync(path + "-shm", "shm");
  };
  openDatabase(path).db.close(); // creates dir
  corrupt();
  const r = openDatabase(path, { now: fixed });
  assert.equal(r.warning, "previous_history_unreadable");
  const base = `${path}.broken-2026-11-14T12-00-00-000Z`;
  assert.equal(r.recoveredTo, base);
  for (const sfx of ["", "-wal", "-shm"]) assert.ok(existsSync(base + sfx), sfx);
  assert.equal(r.db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  r.db.close();

  corrupt();
  const r2 = openDatabase(path, { now: fixed });
  assert.equal(r2.warning, "previous_history_unreadable");
  assert.notEqual(r2.recoveredTo, base);
  assert.ok(existsSync(base));
  assert.ok(existsSync(r2.recoveredTo as string));
  assert.ok(readdirSync(dir).filter((f) => f.includes(".broken-")).length >= 6);
  const store = createStore(r2.db, { warning: r2.warning });
  assert.equal(store.listConversations().warning, "previous_history_unreadable");
  r2.db.close();
});

test("migrations set user_version and reopening does not re-apply", () => {
  const path = tmpPath();
  const a = openDatabase(path);
  assert.equal(a.warning, null);
  assert.equal(a.db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  a.db.prepare("INSERT INTO conversations VALUES ('c','t','a','a',0)").run();
  a.db.close();
  const b = openDatabase(path);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n, 1);
  assert.equal(b.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  b.db.close();
});

test("a v1 database is upgraded in place: data kept, trace lookups by message use the index", () => {
  const path = tmpPath();
  mkdirSync(dirname(path), { recursive: true });
  const v1 = new DatabaseSync(path);
  v1.exec(MIGRATIONS[0] as string);
  v1.exec("PRAGMA user_version = 1");
  v1.prepare("INSERT INTO conversations VALUES ('c','t','a','a',0)").run();
  v1.close();

  const r = openDatabase(path);
  assert.equal(r.db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n, 1);
  const plan = r.db.prepare("EXPLAIN QUERY PLAN SELECT MAX(attempt) FROM turn_traces WHERE user_message_id = ?").all("m");
  assert.match(JSON.stringify(plan), /turn_traces_by_message/);
  r.db.close();
});

test("title is trimmed and cut to 60 chars", () => {
  const s = setup();
  const { conversationId } = first(s, "  " + "x".repeat(100) + "  ");
  assert.equal(s.store.getConversation(conversationId)?.title, "x".repeat(60));
});

test("list is ordered by updated_at descending and carries the warning", () => {
  const s = setup();
  const a = first(s, "a");
  const b = first(s, "b");
  assert.deepEqual(s.store.listConversations().conversations.map((c) => c.id), [b.conversationId, a.conversationId]);
  s.store.acceptMessage(a.conversationId, randomUUID(), "later", 1);
  assert.deepEqual(s.store.listConversations().conversations.map((c) => c.id), [a.conversationId, b.conversationId]);
});

test("failed traces and attempts", () => {
  const s = setup();
  const { id } = first(s);
  assert.equal(s.store.nextAttempt(id), 1);
  s.store.recordFailedTrace(id, 1, "reply_failed", { e: 1 });
  assert.equal(s.store.nextAttempt(id), 2);
  assert.equal(s.store.traces(id)[0]?.outcome, "reply_failed");
  s.db.close();
  assert.doesNotThrow(() => s.store.recordFailedTrace(id, 2, "dropped", {}));
});

test("withTransaction rolls back on throw", () => {
  const s = setup();
  assert.throws(() => withTransaction(s.db, () => {
    s.db.prepare("INSERT INTO conversations VALUES ('z','t','a','a',0)").run();
    throw new Error("boom");
  }));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n, 0);
});

test("a database another process holds is not corrupt: startup fails loudly and history stays where it is", () => {
  const path = tmpPath();
  openDatabase(path).db.close();
  const holder = new DatabaseSync(path);
  holder.exec("PRAGMA locking_mode = EXCLUSIVE");
  holder.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => openDatabase(path));
    assert.equal(readdirSync(join(path, "..")).filter((f) => f.includes(".broken-")).length, 0);
    assert.ok(existsSync(path));
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("only damage counts as corruption, not a lock or a permission error", async () => {
  const { isCorruption } = await import("../src/store/db.ts");
  assert.equal(isCorruption(Object.assign(new Error("file is not a database"), { errcode: 26 })), true);
  assert.equal(isCorruption(Object.assign(new Error("database disk image is malformed"), { errcode: 11 })), true);
  assert.equal(isCorruption(Object.assign(new Error("database is locked"), { errcode: 5 })), false);
  assert.equal(isCorruption(Object.assign(new Error("unable to open database file"), { errcode: 14 })), false);
});
