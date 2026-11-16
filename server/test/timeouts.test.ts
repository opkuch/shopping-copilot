import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { callWithRetry, statusOf } from "../src/llm/call.ts";
import { createBudget } from "../src/pipeline/budget.ts";
import { CallFailed } from "../src/pipeline/ports.ts";
import type { ProseInput, TraceSink, TurnFlags } from "../src/pipeline/ports.ts";
import { createReplyWriter, ungroundedAmounts } from "../src/reply/compose.ts";
import type { ResponsesClient } from "../src/slots/extract.ts";

function makeTrace() {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const trace: TraceSink = { event: (kind, data) => void events.push({ kind, data }) };
  return { trace, events };
}

const rateLimit = (retryAfter?: string) =>
  new OpenAI.RateLimitError(429, {}, "rate limited", new Headers(retryAfter ? { "retry-after": retryAfter } : {}));
const server503 = () => new OpenAI.InternalServerError(503, {}, "unavailable", new Headers());

function sequence(...steps: Array<Error | string>) {
  let calls = 0;
  const fn = async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (typeof step === "string") return step;
    throw step;
  };
  return { fn, calls: () => calls };
}

test("429 and 503 are retried once, then succeed", async () => {
  for (const err of [rateLimit(), server503()]) {
    const { trace, events } = makeTrace();
    const s = sequence(err, "ok");
    const out = await callWithRetry(s.fn, { name: "t", timeoutMs: 1000, budget: createBudget(), trace });
    assert.equal(out, "ok");
    assert.equal(s.calls(), 2);
    const attempts = events.filter((e) => e.kind === "llm_attempt").map((e) => e.data);
    assert.deepEqual(attempts.map((a) => [a.attempt, a.outcome, a.status]), [[1, "http", err.status], [2, "ok", null]]);
  }
});

test("a second failure is not retried again", async () => {
  const s = sequence(server503());
  await assert.rejects(
    callWithRetry(s.fn, { name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace }),
    (e) => e instanceof CallFailed && e.kind === "http" && e.status === 503,
  );
  assert.equal(s.calls(), 2);
});

test("a connection error is retried once; a connection timeout is not", async () => {
  const conn = sequence(new OpenAI.APIConnectionError({ message: "reset" }), "ok");
  assert.equal(await callWithRetry(conn.fn, { name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace }), "ok");
  assert.equal(conn.calls(), 2);

  const timedOut = sequence(new OpenAI.APIConnectionTimeoutError(), "ok");
  await assert.rejects(
    callWithRetry(timedOut.fn, { name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace }),
    (e) => e instanceof CallFailed && e.kind === "timeout",
  );
  assert.equal(timedOut.calls(), 1);
});

test("400 is not retried and keeps its status", async () => {
  const s = sequence(new OpenAI.BadRequestError(400, {}, "bad", new Headers()), "ok");
  await assert.rejects(
    callWithRetry(s.fn, { name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace }),
    (e) => e instanceof CallFailed && e.kind === "http" && e.status === 400,
  );
  assert.equal(s.calls(), 1);
});

test("a timeout is never retried", async () => {
  let calls = 0;
  const { events, trace } = makeTrace();
  await assert.rejects(
    callWithRetry(() => (calls++, new Promise<string>(() => {})), { name: "t", timeoutMs: 20, budget: createBudget(), trace }),
    (e) => e instanceof CallFailed && e.kind === "timeout",
  );
  assert.equal(calls, 1);
  assert.equal(events[0]?.data.outcome, "timeout");
});

test("retry is skipped when the budget is too short", async () => {
  const s = sequence(server503(), "ok");
  await assert.rejects(
    callWithRetry(s.fn, { name: "t", timeoutMs: 1000, budget: createBudget(900), trace: makeTrace().trace }),
    (e) => e instanceof CallFailed && e.kind === "http",
  );
  assert.equal(s.calls(), 1);
});

test("Retry-After is honored and capped at 2000 ms", async () => {
  for (const [header, expected] of [["1", 1000], ["30", 2000]] as const) {
    const waits: number[] = [];
    const s = sequence(rateLimit(header), "ok");
    await callWithRetry(s.fn, {
      name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace,
      sleep: async (ms) => void waits.push(ms),
    });
    assert.deepEqual(waits, [expected]);
  }
});

test("without Retry-After the retry does not sleep", async () => {
  const waits: number[] = [];
  await callWithRetry(sequence(server503(), "ok").fn, {
    name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace,
    sleep: async (ms) => void waits.push(ms),
  });
  assert.deepEqual(waits, []);
});

test("a caller abort is neither retried nor converted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = callWithRetry(
    (signal) => (calls++, new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))),
    { name: "t", timeoutMs: 1000, budget: createBudget(), trace: makeTrace().trace, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (e) => !(e instanceof CallFailed) && (e as Error).name === "AbortError");
  assert.equal(calls, 1);
});

test("statusOf reads the SDK error status", () => {
  assert.equal(statusOf(rateLimit()), 429);
  assert.equal(statusOf(new Error("x")), null);
});

// ---- reply writer ----
const proseInput: ProseInput = {
  kind: "refer", language: "en", message: "tell me about it",
  detail: {
    id: 1, title: "P", description: "d", price: 1, thumbnail: "t", rating: 4, category: "laptops", inStock: true,
    brand: null, availabilityStatus: null, warrantyInformation: null, shippingInformation: null,
    returnPolicy: null, reviewCount: null, source: "live",
  },
};

function replyClient(create: ResponsesClient["responses"]["create"]) {
  const calls: unknown[] = [];
  const client: ResponsesClient = { responses: { create: (body, opts) => (calls.push({ body, opts }), create(body, opts)) } };
  return { client, calls };
}
const textResponse = (text: string) => ({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });

test("reply writer is skipped with under 4000 ms left", async () => {
  const { client, calls } = replyClient(async () => textResponse("hi"));
  const { trace, events } = makeTrace();
  assert.equal(await createReplyWriter(client).write(proseInput, { budget: createBudget(3000), trace }), null);
  assert.equal(calls.length, 0);
  assert.equal(events[0]?.kind, "prose_skipped");
});

test("reply writer returns trimmed text, one call, no SDK retries", async () => {
  const { client, calls } = replyClient(async () => textResponse("  Here are 2 products.  "));
  const out = await createReplyWriter(client).write(proseInput, { budget: createBudget(), trace: makeTrace().trace });
  assert.equal(out, "Here are 2 products.");
  const { body, opts } = calls[0] as { body: Record<string, unknown>; opts: Record<string, unknown> };
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(opts.maxRetries, 0);
});

test("reply writer returns null for > 400 chars, empty text, and a throwing client", async () => {
  const ctx = () => ({ budget: createBudget(), trace: makeTrace().trace });
  const long = replyClient(async () => textResponse("x".repeat(401)));
  assert.equal(await createReplyWriter(long.client).write(proseInput, ctx()), null);
  const empty = replyClient(async () => textResponse("   "));
  assert.equal(await createReplyWriter(empty.client).write(proseInput, ctx()), null);
  const boom = replyClient(async () => { throw server503(); });
  assert.equal(await createReplyWriter(boom.client).write(proseInput, ctx()), null);
  assert.equal(boom.calls.length, 1);
});

test("reply writer gives up at its own timeout", async () => {
  const { client } = replyClient(() => new Promise(() => {}));
  const out = await createReplyWriter(client, { timeoutMs: 20 }).write(proseInput, { budget: createBudget(), trace: makeTrace().trace });
  assert.equal(out, null);
});

const resultsInput: ProseInput = {
  kind: "results", language: "en", message: "what's the cheapest phone?", previous: null,
  draft: "Here are 4 of 16 smartphones, lowest price first.",
  groups: [{
    label: "Smartphones", outcome: "results", match: "exact", droppedWords: [], earlierCardsKept: false, totalMatches: 16,
    request: { priceMin: null, priceMax: 500, sort: "price_asc", inStockOnly: false, topIsFirst: false },
    cards: [
      { position: 1, title: "Realme C35", category: "smartphones", price: 149.99, rating: 4.2, inStock: true },
      { position: 2, title: "iPhone 5s", category: "smartphones", price: 199.99, rating: 2.8, inStock: true },
    ],
  }],
};

test("ungroundedAmounts: card prices, asked bounds, and draft amounts are allowed; anything else is invented", () => {
  assert.deepEqual(ungroundedAmounts("The cheapest is the Realme C35 at $149.99.", resultsInput), []);
  assert.deepEqual(ungroundedAmounts("Everything here is under $500; next is $199.99.", resultsInput), []);
  assert.deepEqual(ungroundedAmounts("The Realme C35 is $139.99.", resultsInput), [139.99]);
  assert.deepEqual(ungroundedAmounts("הזול ביותר הוא Realme C35 ב-149.99$, ואחריו 99$.", { ...resultsInput, language: "he" }), [99]);
  assert.deepEqual(ungroundedAmounts("No prices at all.", resultsInput), []);
});

test("reply writer drops a results reply that quotes an invented price", async () => {
  const { trace, events } = makeTrace();
  const { client, calls } = replyClient(async () => textResponse("The cheapest is the Realme C35 at $129.99."));
  assert.equal(await createReplyWriter(client).write(resultsInput, { budget: createBudget(), trace }), null);
  assert.equal((events.at(-1)?.data as { outcome: string }).outcome, "ungrounded");
  // The results prompt and facts went out, not the detail prompt.
  const body = (calls[0] as { body: { input: Array<{ content: string }> } }).body;
  assert.match(body.input[0]?.content ?? "", /Answer the message directly/);
  assert.equal(JSON.parse(body.input[1]?.content ?? "{}").message, "what's the cheapest phone?");
});
