// Every outcome of a send, as pure function calls.
import { describe, expect, test } from "vitest";
import type { Result } from "../src/api/client.ts";
import type { TurnResponse } from "../src/api/types.ts";
import { CONFLICT_TOAST, INTERNAL_TOAST, planOutcome, STORAGE_TOAST } from "../src/state/outcome.ts";
import type { Sent } from "../src/state/reducer.ts";
import { assistant, conversation, user } from "./fixtures/messages.ts";

const existing: Sent = { messageId: "m1", text: "cheaper", conversationId: "c1", revision: 2 };
const fresh: Sent = { messageId: "m1", text: "cheap sunglasses", conversationId: null, revision: 0 };

const ok = (conversationId = "c1"): Result<TurnResponse> => ({
  ok: true,
  data: { conversationId, revision: 3, userMessage: user({ id: "m1" }), assistantMessage: assistant() },
});
const fail = (f: Exclude<Result<never>, { ok: true }>) => f;

describe("200", () => {
  test("applies the turn; the draft stays empty", () => {
    const p = planOutcome(existing, ok(), true);
    expect(p.actions).toEqual([{ type: "turn_completed", sent: existing, response: (ok() as { data: TurnResponse }).data }]);
    expect(p.restoreDraft).toBe(false);
    expect(p.replaceRoute).toBeNull();
  });

  test("a new chat replaces home with the conversation, only if the user is still home", () => {
    expect(planOutcome(fresh, ok("c9"), true).replaceRoute).toEqual({ view: "conversation", id: "c9" });
    expect(planOutcome(fresh, ok("c9"), false).replaceRoute).toBeNull();
  });
});

describe("409", () => {
  test("a transcript without the message restores the draft and says why", () => {
    const winner = conversation({ revision: 3 });
    const p = planOutcome(existing, fail({ ok: false, kind: "conflict", conversation: winner }), true);
    expect(p.actions).toEqual([
      { type: "conflict", sent: existing, conversation: winner },
      { type: "toast", message: CONFLICT_TOAST },
    ]);
    expect(p.restoreDraft).toBe(true);
  });

  test("a transcript that already has the message (a resend that is no longer the tail) does not", () => {
    const stored = conversation({ messages: [user({ id: "m1" }), user({ id: "m2", text: "later" })] });
    const p = planOutcome(existing, fail({ ok: false, kind: "conflict", conversation: stored }), true);
    expect(p.restoreDraft).toBe(false);
    expect(p.actions.some((a) => a.type === "toast")).toBe(false);
  });
});

describe("503 reply_failed", () => {
  const replyFailed = fail({ ok: false, kind: "reply_failed", conversationId: "c9", revision: 1, userMessageId: "m1" });

  test("an existing chat reloads, so the stored message shows as the unanswered tail", () => {
    const p = planOutcome(existing, replyFailed, true);
    expect(p.actions).toEqual([{ type: "send_failed", sent: existing }]);
    expect(p.reloadConversation).toBe(true);
    expect(p.restoreDraft).toBe(false);
  });

  test("a new chat opens the conversation the server created", () => {
    const p = planOutcome(fresh, replyFailed, true);
    expect(p.replaceRoute).toEqual({ view: "conversation", id: "c9" });
    expect(p.restoreDraft).toBe(false);
  });
});

describe("errors that stored nothing", () => {
  test("500 storage_failed restores the draft with a toast", () => {
    const p = planOutcome(existing, fail({ ok: false, kind: "storage_failed", message: "x" }), true);
    expect(p.actions).toContainEqual({ type: "toast", message: STORAGE_TOAST });
    expect(p.restoreDraft).toBe(true);
  });

  test("400 validation restores the draft and shows the server's message", () => {
    const p = planOutcome(existing, fail({ ok: false, kind: "validation", message: "Too long." }), true);
    expect(p.actions).toContainEqual({ type: "toast", message: "Too long." });
    expect(p.restoreDraft).toBe(true);
  });

  test("404 sends the user home and restores the draft there", () => {
    const p = planOutcome(existing, fail({ ok: false, kind: "not_found", message: "x" }), true);
    expect(p.actions).toContainEqual({ type: "conversation_not_found", id: "c1" });
    expect(p.replaceRoute).toEqual({ view: "home" });
    expect(p.restoreDraft).toBe(true);
  });
});

describe("unknown outcomes", () => {
  test("500 internal reloads and decides the draft by the reloaded transcript", () => {
    const p = planOutcome(existing, fail({ ok: false, kind: "internal", message: "x" }), true);
    expect(p.actions).toContainEqual({ type: "toast", message: INTERNAL_TOAST });
    expect(p.reloadConversation).toBe(true);
    expect(p.restoreIfMissingAfterReload).toBe(true);
    expect(p.restoreDraft).toBe(false);
  });

  test("a network failure keeps the bubble as Not sent; nothing is restored", () => {
    const p = planOutcome(existing, fail({ ok: false, kind: "network", message: "x" }), true);
    expect(p.actions).toEqual([{ type: "not_sent", sent: existing }]);
    expect(p.restoreDraft).toBe(false);
    expect(p.reloadConversation).toBe(false);
  });
});
