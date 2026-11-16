// The whole app over a fake ApiClient: send.ts and the effects in effects.ts run for real, which the
// reducer and render tests cannot cover. The browser tests (e2e/) cover the same flows over HTTP.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiClient, Result } from "../src/api/client.ts";
import type { ConversationView, Stage, TurnResponse } from "../src/api/types.ts";
import { App } from "../src/App.tsx";
import { assistant, conversation, user } from "./fixtures/messages.ts";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** An in-memory server: conversations by id, a scripted stage, and every call recorded. */
function fakeClient(opts: { conversations?: ConversationView[]; stage?: Stage } = {}) {
  const store = new Map((opts.conversations ?? []).map((c) => [c.id, c]));
  const calls: Array<{ method: string; arg?: unknown }> = [];
  let hold: Promise<void> | null = null;
  const respond = (conversationId: string, messageId: string, text: string): TurnResponse => {
    const prev = store.get(conversationId);
    const u = user({ id: messageId, text });
    const a = assistant({ id: `a-${messageId}` });
    const messages = [...(prev?.messages ?? []).filter((m) => m.id !== messageId), u, a];
    const revision = (prev?.revision ?? 0) + 1;
    store.set(conversationId, { id: conversationId, title: prev?.title ?? text, revision, messages });
    return { conversationId, revision, userMessage: u, assistantMessage: a };
  };
  const client: ApiClient = {
    listConversations: async () => {
      calls.push({ method: "list" });
      return ok({
        conversations: [...store.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: "2026-11-14T10:00:00.000Z" })),
        warning: null,
      });
    },
    getConversation: async (id) => {
      calls.push({ method: "get", arg: id });
      const c = store.get(id);
      return c ? ok(structuredClone(c)) : { ok: false, kind: "not_found", message: "gone" };
    },
    createConversation: async (body) => {
      calls.push({ method: "create", arg: body });
      if (hold) await hold;
      return ok(respond("c-new", body.messageId, body.text));
    },
    sendMessage: async (id, body) => {
      calls.push({ method: "send", arg: { id, ...body } });
      if (hold) await hold;
      return ok(respond(id, body.messageId, body.text));
    },
    getProgress: async (messageId) => {
      calls.push({ method: "progress", arg: messageId });
      return ok({ stage: opts.stage ?? "idle" });
    },
  };
  return {
    client,
    calls,
    holdTurns() {
      const d = deferred<void>();
      hold = d.promise;
      return () => d.resolve();
    },
  };
}

const composer = () => screen.getByRole("textbox", { name: "Message" });
function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.keyDown(composer(), { key: "Enter" });
}

test("a new chat: the reply shows without a loading flash, the URL moves, and the reply is announced", async () => {
  const fake = fakeClient();
  const release = fake.holdTurns();
  render(<App client={fake.client} />);

  type("cheap sunglasses");
  // While the turn runs, the user's message is on screen with the pending reply.
  await screen.findByText("cheap sunglasses", { selector: ".bubble, .bubble *" });

  const spinnerSeen = vi.fn();
  const observer = new MutationObserver(() => {
    if (screen.queryByText("Loading conversation")) spinnerSeen();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  await act(async () => release());

  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(within(log).getAllByRole("article")).toHaveLength(4));
  observer.disconnect();
  expect(spinnerSeen).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/c/c-new");
  const announcer = screen.getAllByRole("status").find((el) => el.getAttribute("aria-atomic") === "true");
  expect(announcer?.textContent).toContain("Sunglasses: 4 of 23 results.");
});

test("a follow-up sends to the open conversation with its revision", async () => {
  const fake = fakeClient({ conversations: [conversation()] });
  window.history.replaceState(null, "", "/c/c1");
  render(<App client={fake.client} />);
  await screen.findByRole("log", { name: "Conversation" });

  type("tell me more");
  await waitFor(() => expect(fake.calls.some((c) => c.method === "send")).toBe(true));
  const sent = fake.calls.find((c) => c.method === "send")?.arg as { id: string; revision: number; text: string };
  expect(sent).toMatchObject({ id: "c1", revision: 1, text: "tell me more" });
  await waitFor(() => expect(screen.getAllByText("tell me more").length).toBeGreaterThan(0));
});

test("an unanswered tail with a run in flight is resent once with the same message id", async () => {
  const tail = user({ id: "u-tail", text: "slow laptops" });
  const fake = fakeClient({ conversations: [conversation({ messages: [user(), assistant(), tail], revision: 2 })], stage: "searching" });
  window.history.replaceState(null, "", "/c/c1");
  render(<App client={fake.client} />);

  await waitFor(() => expect(fake.calls.filter((c) => c.method === "send")).toHaveLength(1));
  expect(fake.calls.find((c) => c.method === "send")?.arg).toMatchObject({ messageId: "u-tail", text: "slow laptops", revision: 2 });
  await waitFor(() => expect(screen.queryByText("No reply yet.")).toBeNull());
  const log = screen.getByRole("log", { name: "Conversation" });
  await waitFor(() => expect(within(log).getAllByRole("article")).toHaveLength(8));
});

test("a tail that cannot resume because another send is in flight shows Retry instead of hanging", async () => {
  // Its own id: effects.ts remembers resumed ids for the page's lifetime, across tests in this file.
  const tail = user({ id: "u-busy", text: "slow laptops" });
  const fake = fakeClient({ conversations: [conversation({ messages: [user(), assistant(), tail], revision: 2 })], stage: "searching" });
  const release = fake.holdTurns();
  render(<App client={fake.client} />);

  type("a new chat that is still running");
  await waitFor(() => expect(fake.calls.some((c) => c.method === "create")).toBe(true));
  const nav = screen.getByRole("navigation", { name: "Conversations" });
  fireEvent.click(await within(nav).findByRole("link", { name: /cheap sunglasses/ }));

  await screen.findByText("No reply yet.");
  expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
  expect(fake.calls.some((c) => c.method === "send")).toBe(false);
  await act(async () => release());
  await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false));
});

test("an unanswered tail with nothing running shows Retry, and Retry resends the same message", async () => {
  const tail = user({ id: "u-tail", text: "laptops" });
  const fake = fakeClient({ conversations: [conversation({ messages: [user(), assistant(), tail], revision: 2 })], stage: "idle" });
  window.history.replaceState(null, "", "/c/c1");
  render(<App client={fake.client} />);

  await screen.findByText("No reply yet.");
  expect(fake.calls.some((c) => c.method === "send")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fake.calls.find((c) => c.method === "send")?.arg).toMatchObject({ messageId: "u-tail" }));
  await waitFor(() => expect(screen.queryByText("No reply yet.")).toBeNull());
});
