import { describe, expect, test } from "vitest";
import type { TurnResponse } from "../src/api/types.ts";
import { initialState, mergeMessages, NOT_FOUND_TOAST, reducer } from "../src/state/reducer.ts";
import type { Sent } from "../src/state/reducer.ts";
import { assistant, conversation, group, user } from "./fixtures/messages.ts";

const home = { view: "home" } as const;
const item = { id: "c1", title: "t", updatedAt: "2026-11-14T10:00:00.000Z" };

test("a route change to the same route keeps the same state object", () => {
  const s = initialState({ view: "conversation", id: "a" });
  expect(reducer(s, { type: "route_changed", route: { view: "conversation", id: "a" } })).toBe(s);
  expect(reducer(s, { type: "route_changed", route: home }).route).toEqual(home);
});

test("the list loads, and a failed refetch keeps the last good rows", () => {
  let s = initialState(home);
  expect(s.list.status).toBe("loading");
  s = reducer(s, { type: "list_failed" });
  expect(s.list.status).toBe("error");
  s = reducer(s, { type: "list_loaded", items: [item], warning: null });
  expect(s.list).toEqual({ status: "ready", items: [item], warning: null });
  s = reducer(s, { type: "list_loading" });
  expect(s.list.status).toBe("ready");
  s = reducer(s, { type: "list_failed" });
  expect(s.list).toEqual({ status: "ready", items: [item], warning: null });
});

test("opening a different conversation never shows the previous transcript", () => {
  let s = initialState({ view: "conversation", id: "a" });
  expect(s.conversation).toEqual({ status: "loading", id: "a" });
  s = reducer(s, { type: "conversation_loaded", view: conversation({ id: "a" }) });
  expect(s.conversation.status).toBe("ready");
  s = reducer(s, { type: "route_changed", route: { view: "conversation", id: "b" } });
  expect(s.conversation).toEqual({ status: "loading", id: "b" });
  s = reducer(s, { type: "route_changed", route: home });
  expect(s.conversation).toEqual({ status: "none" });
});

test("a load response for A after the route moved to B is ignored", () => {
  let s = initialState({ view: "conversation", id: "b" });
  const before = s;
  s = reducer(s, { type: "conversation_loaded", view: conversation({ id: "a" }) });
  s = reducer(s, { type: "conversation_failed", id: "a" });
  s = reducer(s, { type: "conversation_not_found", id: "a" });
  expect(s).toBe(before);
});

test("a failed first load is an error state; a failed refresh keeps the transcript", () => {
  let s = initialState({ view: "conversation", id: "a" });
  s = reducer(s, { type: "conversation_failed", id: "a" });
  expect(s.conversation).toEqual({ status: "error", id: "a" });
  s = reducer(s, { type: "conversation_loaded", view: conversation({ id: "a" }) });
  s = reducer(s, { type: "conversation_failed", id: "a" });
  expect(s.conversation.status).toBe("ready");
});

test("a conversation that is gone sends the user home with a toast", () => {
  let s = initialState({ view: "conversation", id: "a" });
  s = reducer(s, { type: "conversation_not_found", id: "a" });
  expect(s.route).toEqual(home);
  expect(s.conversation).toEqual({ status: "none" });
  expect(s.toast?.text).toBe(NOT_FOUND_TOAST);
});

const response = (conversationId = "a"): TurnResponse => ({
  conversationId, revision: 2, userMessage: user({ id: "m1", text: "cheaper" }), assistantMessage: assistant({ id: "r1" }),
});
const ready = () =>
  reducer(initialState({ view: "conversation", id: "a" }), { type: "conversation_loaded", view: conversation({ id: "a" }) });

describe("sending", () => {
  const sent: Sent = { messageId: "m1", text: "cheaper", conversationId: "a", revision: 1 };

  test("one send at a time, app-wide", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    const other: Sent = { ...sent, messageId: "m2" };
    expect(reducer(s, { type: "send_started", sent: other })).toBe(s);
    s = reducer(s, { type: "stage", messageId: "m1", stage: "searching" });
    expect(s.inflight?.stage).toBe("searching");
    expect(reducer(s, { type: "stage", messageId: "other", stage: "writing" })).toBe(s);
  });

  test("cards first: a preview is kept once seen, even when a later poll has none", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    const preview = { groups: [group()], text: "Here are 4 of 23 sunglasses." };
    s = reducer(s, { type: "stage", messageId: "m1", stage: "writing", preview });
    expect(s.inflight?.preview).toBe(preview);
    s = reducer(s, { type: "stage", messageId: "m1", stage: "writing", preview: null });
    expect(s.inflight?.preview).toBe(preview);
  });

  test("a poll with the same preview (a new object, same content) changes nothing, so nothing re-renders", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    s = reducer(s, { type: "stage", messageId: "m1", stage: "writing", preview: { groups: [group()], text: "Here are 4." } });
    const again = reducer(s, { type: "stage", messageId: "m1", stage: "writing", preview: { groups: [group()], text: "Here are 4." } });
    expect(again).toBe(s);
    const changed = reducer(s, { type: "stage", messageId: "m1", stage: "writing", preview: { groups: [group()], text: "Here are 5." } });
    expect(changed).not.toBe(s);
  });

  test("a 200 merges both messages and takes the new revision", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    s = reducer(s, { type: "turn_completed", sent, response: response() });
    expect(s.inflight).toBeNull();
    const view = s.conversation.status === "ready" ? s.conversation.view : null;
    expect(view?.messages.map((m) => m.id)).toEqual(["u1", "a1", "m1", "r1"]);
    expect(view?.revision).toBe(2);
  });

  test("delivering the same turn twice leaves one copy of each message", () => {
    let s = reducer(ready(), { type: "turn_completed", sent, response: response() });
    s = reducer(s, { type: "turn_completed", sent, response: response() });
    const view = s.conversation.status === "ready" ? s.conversation.view : null;
    expect(view?.messages.map((m) => m.id)).toEqual(["u1", "a1", "m1", "r1"]);
  });

  test("mergeMessages updates in place and appends new ones in order", () => {
    const merged = mergeMessages([user({ id: "x" }), assistant({ id: "y", text: "old" })], [assistant({ id: "y", text: "new" }), user({ id: "z" })]);
    expect(merged.map((m) => `${m.id}:${m.text}`)).toEqual(["x:cheap sunglasses", "y:new", "z:cheap sunglasses"]);
  });

  test("a 200 for conversation A while B is open does not touch B", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    s = reducer(s, { type: "route_changed", route: { view: "conversation", id: "b" } });
    s = reducer(s, { type: "conversation_loaded", view: conversation({ id: "b", messages: [] }) });
    s = reducer(s, { type: "turn_completed", sent, response: response("a") });
    expect(s.inflight).toBeNull();
    expect(s.conversation.status === "ready" && s.conversation.view.messages).toEqual([]);
  });

  test("a 200 for a new chat while still home opens it with both messages", () => {
    const first: Sent = { messageId: "m1", text: "  cheap sunglasses  ", conversationId: null, revision: 0 };
    let s = reducer(initialState(home), { type: "send_started", sent: first });
    s = reducer(s, { type: "turn_completed", sent: first, response: response("new-id") });
    expect(s.route).toEqual({ view: "conversation", id: "new-id" });
    expect(s.conversation.status === "ready" && s.conversation.view.messages.length).toBe(2);
  });

  test("a 200 for a new chat after the user left home only clears the send", () => {
    const first: Sent = { messageId: "m1", text: "x", conversationId: null, revision: 0 };
    let s = reducer(initialState(home), { type: "send_started", sent: first });
    s = reducer(s, { type: "route_changed", route: { view: "conversation", id: "b" } });
    s = reducer(s, { type: "turn_completed", sent: first, response: response("new-id") });
    expect(s.route).toEqual({ view: "conversation", id: "b" });
    expect(s.inflight).toBeNull();
  });

  test("a conflict replaces the transcript with the server's", () => {
    const winner = conversation({ id: "a", revision: 5, messages: [user({ id: "other" })] });
    let s = reducer(ready(), { type: "send_started", sent });
    s = reducer(s, { type: "conflict", sent, conversation: winner });
    expect(s.inflight).toBeNull();
    expect(s.conversation).toEqual({ status: "ready", view: winner });
  });

  test("a network failure becomes notSent; leaving the conversation forgets it", () => {
    let s = reducer(ready(), { type: "send_started", sent });
    s = reducer(s, { type: "not_sent", sent });
    expect(s.inflight).toBeNull();
    expect(s.notSent).toEqual(sent);
    s = reducer(s, { type: "route_changed", route: home });
    expect(s.notSent).toBeNull();
  });

  test("the unanswered tail is checked, then stalled; a route change resets it", () => {
    let s = reducer(ready(), { type: "tail_checking", messageId: "u1" });
    expect(s.tail).toEqual({ messageId: "u1", status: "checking" });
    expect(reducer(s, { type: "tail_stalled", messageId: "other" })).toBe(s);
    s = reducer(s, { type: "tail_stalled", messageId: "u1" });
    expect(s.tail?.status).toBe("stalled");
    s = reducer(s, { type: "route_changed", route: home });
    expect(s.tail).toBeNull();
  });
});

test("a new chat's first reply is not replaced by a spinner when the conversation load starts", () => {
  const first: Sent = { messageId: "m1", text: "cheap sunglasses", conversationId: null, revision: 0 };
  let s = reducer(initialState(home), { type: "send_started", sent: first });
  s = reducer(s, { type: "turn_completed", sent: first, response: response("new-id") });
  const shown = s.conversation;
  // useConversation sees the new id and starts a load; the reply must stay on screen.
  s = reducer(s, { type: "conversation_loading", id: "new-id" });
  expect(s.conversation).toBe(shown);
  expect(s.conversation.status).toBe("ready");
});

test("a reply is announced as its sentence plus a count per group, not card by card", () => {
  const s = reducer(ready(), { type: "turn_completed", sent: { messageId: "m1", text: "x", conversationId: "a", revision: 1 }, response: response() });
  expect(s.announcement?.id).toBe("r1");
  expect(s.announcement?.text).toBe("Here are 4 of 23 sunglasses, lowest price first. Sunglasses: 4 of 23 results.");
});

test("toasts show and dismiss; the same text twice gets a new id", () => {
  let s = initialState(home);
  s = reducer(s, { type: "toast", message: "hello" });
  expect(s.toast?.text).toBe("hello");
  const first = s.toast?.id;
  s = reducer(s, { type: "toast", message: "hello" });
  expect(s.toast?.id).not.toBe(first);
  s = reducer(s, { type: "toast_dismissed" });
  expect(s.toast).toBeNull();
  expect(reducer(s, { type: "toast_dismissed" })).toBe(s);
});
