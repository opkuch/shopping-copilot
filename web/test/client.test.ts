import { describe, expect, test } from "vitest";
import { MAX_TEXT as SERVER_MAX_TEXT } from "../../server/src/messages/schema.ts";
import { createApiClient } from "../src/api/client.ts";
import { MAX_TEXT } from "../src/api/types.ts";

type Call = { url: string; init: RequestInit };

function stub(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const error = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message: `msg ${code}` }, ...extra });

const conversation = { id: "c1", title: "t", revision: 2, messages: [] };
const body = { messageId: "m1", text: "hi", revision: 1 };

describe("request shape", () => {
  test("each route uses its method, path, and JSON body", async () => {
    const { fetch, calls } = stub(() => json(200, {}));
    const api = createApiClient({ fetch });
    await api.listConversations();
    await api.getConversation("a b/c");
    await api.createConversation({ messageId: "m1", text: "hi" });
    await api.sendMessage("c1", body);
    await api.getProgress("m1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET /api/conversations",
      "GET /api/conversations/a%20b%2Fc",
      "POST /api/conversations",
      "POST /api/conversations/c1/messages",
      "GET /api/messages/m1/progress",
    ]);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual(body);
    const headers = calls[3]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBeUndefined();
  });
});

describe("outcome mapping", () => {
  test("200 returns the data", async () => {
    const { fetch } = stub(() => json(200, conversation));
    expect(await createApiClient({ fetch }).getConversation("c1")).toEqual({ ok: true, data: conversation });
  });

  test("409 carries the server's transcript", async () => {
    const { fetch } = stub(() => error(409, "revision_conflict", { conversation }));
    expect(await createApiClient({ fetch }).sendMessage("c1", body)).toEqual({ ok: false, kind: "conflict", conversation });
  });

  test("503 carries what a resend needs", async () => {
    const { fetch } = stub(() => error(503, "reply_failed", { conversationId: "c1", revision: 1, userMessageId: "m1", retryable: true }));
    expect(await createApiClient({ fetch }).sendMessage("c1", body)).toEqual({
      ok: false, kind: "reply_failed", conversationId: "c1", revision: 1, userMessageId: "m1",
    });
  });

  test.each([
    [500, "storage_failed"],
    [500, "internal"],
    [400, "validation"],
    [404, "not_found"],
  ])("%i %s keeps the server message", async (status, code) => {
    const { fetch } = stub(() => error(status, code));
    expect(await createApiClient({ fetch }).sendMessage("c1", body)).toEqual({ ok: false, kind: code, message: `msg ${code}` });
  });

  test("a 409 or 503 missing its fields, or an unknown code, is a network failure", async () => {
    for (const res of [error(409, "revision_conflict"), error(503, "reply_failed"), error(418, "teapot"), json(502, { nope: 1 })]) {
      const { fetch } = stub(() => res);
      const out = await createApiClient({ fetch }).sendMessage("c1", body);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.kind).toBe("network");
    }
  });

  test("a non-JSON body is a network failure, whatever the status", async () => {
    for (const status of [200, 502]) {
      const { fetch } = stub(() => new Response("<html>proxy error</html>", { status }));
      const out = await createApiClient({ fetch }).listConversations();
      expect(out.ok === false && out.kind).toBe("network");
    }
  });

  test("a thrown fetch is a network failure", async () => {
    const { fetch } = stub(() => {
      throw new TypeError("Failed to fetch");
    });
    const out = await createApiClient({ fetch }).listConversations();
    expect(out).toEqual({ ok: false, kind: "network", message: "Couldn't reach the server." });
  });
});

// A fetch that only settles when its signal aborts, like a server that never answers.
const hanging = stub(
  ({ init }) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
);

describe("timeouts and aborts", () => {
  test("a turn that outlives its timeout is a network failure", async () => {
    const out = await createApiClient({ fetch: hanging.fetch, turnTimeoutMs: 20 }).sendMessage("c1", body);
    expect(out).toEqual({ ok: false, kind: "network", message: "The server took too long to answer." });
  });

  test("a read uses its own timeout", async () => {
    const out = await createApiClient({ fetch: hanging.fetch, readTimeoutMs: 20, turnTimeoutMs: 60_000 }).getConversation("c1");
    expect(out.ok === false && out.kind).toBe("network");
  });

  test("a caller abort is reported as aborted, not as a failure", async () => {
    const controller = new AbortController();
    const pending = createApiClient({ fetch: hanging.fetch }).getConversation("c1", controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, kind: "aborted" });
  });

  test("an abort while the body is being read is still aborted", async () => {
    const controller = new AbortController();
    const { fetch } = stub(() => {
      controller.abort();
      return json(200, conversation);
    });
    expect(await createApiClient({ fetch }).getConversation("c1", controller.signal)).toEqual({ ok: false, kind: "aborted" });
  });
});

test("the client's text limit matches the server's", () => {
  expect(MAX_TEXT).toBe(SERVER_MAX_TEXT);
});
