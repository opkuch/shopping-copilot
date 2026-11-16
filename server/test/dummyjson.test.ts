import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { Budget, CallCtx, RawProductFull } from "../src/pipeline/ports.ts";
import { CallFailed } from "../src/pipeline/ports.ts";
import { createDummyJsonApi } from "../src/retrieval/dummyjson.ts";
import { createUrlCache, createCategoryNames } from "../src/catalog/cache.ts";

const catalog = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8")) as RawProductFull[];
const categoryList = JSON.parse(readFileSync(new URL("./fixtures/categories.json", import.meta.url), "utf8")) as unknown[];

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl = "";
let script: Handler[] = [];
let requests: string[] = [];
const hung: ServerResponse[] = [];

const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const ok: Handler = (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/products/categories") return json(res, categoryList);
  const cat = url.pathname.match(/^\/products\/category\/(.+)$/);
  if (cat) return json(res, { products: catalog.filter((p) => p.category === cat[1]), total: 0, skip: 0, limit: 0 });
  const one = url.pathname.match(/^\/products\/(\d+)$/);
  if (one) {
    const p = catalog.find((c) => c.id === Number(one[1]));
    return p ? json(res, p) : json(res, { message: "not found" }, 404);
  }
  json(res, { products: catalog.slice(0, 3), total: catalog.length, skip: 0, limit: 3 });
};
const status = (code: number, headers: Record<string, string> = {}): Handler => (_req, res) => json(res, { message: "x" }, code, headers);
const hang: Handler = (_req, res) => void hung.push(res);

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    (script.shift() ?? ok)(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const r of hung) r.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  script = [];
  requests = [];
});

const bigBudget: Budget = { remaining: () => 1e9, timeoutFor: (t) => t };
function makeCtx(budget: Budget = bigBudget) {
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx: CallCtx = { budget, trace: { event: (kind, data) => void events.push({ kind, data }) } };
  return { ctx, events };
}
function makeApi(extra: Parameters<typeof createDummyJsonApi>[0] extends infer T ? Partial<T> : never = {}) {
  const sleeps: number[] = [];
  const api = createDummyJsonApi({ baseUrl, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { api, sleeps };
}

test("every list request carries select and the documented shape", async () => {
  const { api } = makeApi();
  const { ctx } = makeCtx();
  await api.byCategory("laptops", ctx);
  await api.search("red lipstick", ctx);
  await api.all(ctx);
  const select = "select=title,description,price,thumbnail,rating,category,stock,brand,tags,discountPercentage";
  assert.deepEqual(requests, [
    `/products/category/laptops?limit=0&${select}`,
    `/products/search?q=red%20lipstick&limit=0&${select}`,
    `/products?limit=0&${select}`,
  ]);
  assert.equal((await api.product(1, ctx)).id, 1);
  assert.equal((await api.categories(ctx)).length, 24);
  assert.ok(requests.slice(3).every((u) => !u.includes("select")));
});

test("one retry on 503 and on 429, then success", async () => {
  for (const code of [503, 429]) {
    requests = [];
    script = [status(code)];
    const { api, sleeps } = makeApi();
    const { ctx, events } = makeCtx();
    const r = await api.byCategory("laptops", ctx);
    assert.equal(r.products.length, 5);
    assert.equal(requests.length, 2);
    assert.deepEqual(sleeps, [0]);
    const attempts = events.filter((e) => e.kind === "catalog_request").map((e) => [e.data.attempt, e.data.status]);
    assert.deepEqual(attempts, [[1, code], [2, 200]]);
  }
});

test("only one retry: two 503s fail with CallFailed", async () => {
  script = [status(503), status(503), status(503)];
  const { api } = makeApi();
  await assert.rejects(api.all(makeCtx().ctx), (e: unknown) => e instanceof CallFailed && e.kind === "http" && e.status === 503);
  assert.equal(requests.length, 2);
});

test("no retry on 404 or other statuses", async () => {
  for (const code of [404, 500]) {
    requests = [];
    script = [status(code)];
    const { api } = makeApi();
    await assert.rejects(api.product(999999, makeCtx().ctx), (e: unknown) => e instanceof CallFailed && e.status === code);
    assert.equal(requests.length, 1);
  }
});

test("retry on a network error", async () => {
  script = [(req) => req.socket.destroy()];
  const { api } = makeApi();
  const r = await api.byCategory("laptops", makeCtx().ctx);
  assert.equal(r.products.length, 5);
  assert.equal(requests.length, 2);
});

test("Retry-After is honored through the injected sleep and capped at 2000 ms", async () => {
  script = [status(429, { "retry-after": "1" })];
  const first = makeApi();
  await first.api.all(makeCtx().ctx);
  assert.deepEqual(first.sleeps, [1000]);

  script = [status(503, { "retry-after": "30" })];
  const second = makeApi();
  await second.api.all(makeCtx().ctx);
  assert.deepEqual(second.sleeps, [2000]);
});

test("no retry when the budget cannot cover the wait plus a minimal attempt", async () => {
  script = [status(429, { "retry-after": "2" })];
  const { api, sleeps } = makeApi();
  const tight: Budget = { remaining: () => 2100, timeoutFor: (t) => Math.min(t, 2100) };
  await assert.rejects(api.all(makeCtx(tight).ctx), CallFailed);
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);

  requests = [];
  script = [status(503)];
  const exhausted: Budget = { remaining: () => 100, timeoutFor: (t) => Math.min(t, 100) };
  await assert.rejects(makeApi().api.all(makeCtx(exhausted).ctx), CallFailed);
  assert.equal(requests.length, 1);
});

test("a hung server is cut off by the timeout and not retried", async () => {
  script = [hang, hang];
  const { api } = makeApi({ timeoutMs: 30 });
  await assert.rejects(api.all(makeCtx().ctx), (e: unknown) => e instanceof CallFailed && e.kind === "timeout");
  assert.equal(requests.length, 1);
});

test("the budget shortens the timeout", async () => {
  script = [hang];
  const { api } = makeApi({ timeoutMs: 60000 });
  const short: Budget = { remaining: () => 1e9, timeoutFor: () => 30 };
  await assert.rejects(api.all(makeCtx(short).ctx), (e: unknown) => e instanceof CallFailed && e.kind === "timeout");
});

test("a fresh cache hit makes no request; the trace says cacheHit", async () => {
  let t = 1000;
  const cache = createUrlCache({ ttlMs: 300_000, maxEntries: 200, now: () => t });
  const { api } = makeApi({ cache });
  const { ctx, events } = makeCtx();
  await api.byCategory("laptops", ctx);
  t += 299_000;
  const again = await api.byCategory("laptops", ctx);
  assert.equal(again.products.length, 5);
  // Only this test's own URL: a request cut off by the hang tests above can reach the test server late,
  // after the shared list was reset, and was counted here under load (an intermittent failure).
  assert.equal(requests.filter((u) => u.includes("/products/category/laptops")).length, 1);
  const last = events.filter((e) => e.kind === "catalog_request").at(-1);
  assert.equal(last?.data.cacheHit, true);
  assert.equal(last?.data.stale, false);
});

test("stale cache is served when the server fails, and traced", async () => {
  let t = 1000;
  const cache = createUrlCache({ ttlMs: 300_000, maxEntries: 200, now: () => t });
  const { api } = makeApi({ cache });
  await api.byCategory("laptops", makeCtx().ctx);
  t += 10 * 3_600_000; // far past the TTL
  script = [status(500)];
  const { ctx, events } = makeCtx();
  const r = await api.byCategory("laptops", ctx);
  assert.equal(r.products.length, 5);
  assert.equal(requests.length, 2);
  assert.ok(events.some((e) => e.kind === "catalog_stale"));
  assert.ok(events.some((e) => e.kind === "catalog_request" && e.data.stale === true));
  // nothing cached for a different URL: the failure surfaces
  script = [status(500)];
  await assert.rejects(api.byCategory("tablets", makeCtx().ctx), CallFailed);
});

test("traces carry no headers", async () => {
  script = [status(429, { "retry-after": "1", "x-secret": "nope" })];
  const { api } = makeApi();
  const { ctx, events } = makeCtx();
  await api.all(ctx);
  assert.doesNotMatch(JSON.stringify(events), /secret|retry-after/i);
});

test("url cache evicts the oldest-inserted entry; re-setting moves a key to newest", () => {
  let t = 0;
  const cache = createUrlCache({ ttlMs: 100, maxEntries: 2, now: () => t });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 3);
  cache.set("c", 4);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("a"), { value: 3, fresh: true });
  t = 100;
  assert.deepEqual(cache.get("c"), { value: 4, fresh: false });
});

test("category names load once, refresh after TTL, keep the last good list, never throw", async () => {
  let t = 0;
  let calls = 0;
  let failing = false;
  const api = {
    async categories() {
      calls++;
      if (failing) throw new CallFailed("network", "down");
      return [{ slug: "beauty", name: `Beauty ${calls}` }];
    },
  } as unknown as Parameters<typeof createCategoryNames>[0];
  const names = createCategoryNames(api, { ttlMs: 1000, now: () => t });
  const { ctx } = makeCtx();

  failing = true;
  assert.equal(await names.names(ctx), null);
  failing = false;
  assert.deepEqual(await names.names(ctx), [{ slug: "beauty", name: "Beauty 2" }]);
  await names.names(ctx);
  assert.equal(calls, 2);
  t = 1000;
  failing = true;
  assert.deepEqual(await names.names(ctx), [{ slug: "beauty", name: "Beauty 2" }]);
  failing = false;
  assert.deepEqual(await names.names(ctx), [{ slug: "beauty", name: "Beauty 4" }]);
});
