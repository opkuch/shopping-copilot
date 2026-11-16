import { CallFailed } from "../pipeline/ports.ts";
import type { CallCtx, CatalogApi, CategoryInfo, RawProduct, RawProductFull } from "../pipeline/ports.ts";
import type { UrlCache } from "../catalog/cache.ts";

// brand and tags carry what titles often omit ("Apple", "earrings", "over-ear headphones").
const SELECT = "select=title,description,price,thumbnail,rating,category,stock,brand,tags,discountPercentage";
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 2000;
// A retry that cannot start with at least this much budget left would only run into the deadline.
const MIN_ATTEMPT_MS = 250;

type ListBody = { products: RawProduct[]; total?: number };

export function createDummyJsonApi(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  cache?: UrlCache;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): CatalogApi {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.baseUrl.replace(/\/+$/, "");

  function retryWait(res: Response | null): number {
    const header = res?.headers.get("retry-after");
    const secs = header === null || header === undefined ? NaN : Number(header);
    return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_WAIT_MS) : 0;
  }

  async function get(path: string, ctx: CallCtx): Promise<unknown> {
    const url = base + path;
    const cached = opts.cache?.get(url);
    const record = (d: { status: number | null; ms: number; attempt: number; cacheHit: boolean; stale: boolean }) =>
      ctx.trace.event("catalog_request", { path, ...d });

    if (cached?.fresh) {
      record({ status: null, ms: 0, attempt: 0, cacheHit: true, stale: false });
      return cached.value;
    }

    let failure: CallFailed | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = now();
      let res: Response | null = null;
      let retryable = false;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(ctx.budget.timeoutFor(timeoutMs)) });
        if (res.ok) {
          const body: unknown = await res.json();
          record({ status: res.status, ms: now() - started, attempt, cacheHit: false, stale: false });
          opts.cache?.set(url, body);
          return body;
        }
        retryable = RETRY_STATUSES.has(res.status);
        failure = new CallFailed("http", `DummyJSON ${res.status} for ${path}`, res.status);
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          // a timeout already spent its budget, so it is never retried
          failure = new CallFailed("timeout", `DummyJSON timed out for ${path}`);
        } else if (err instanceof SyntaxError) {
          failure = new CallFailed("parse", `DummyJSON returned invalid JSON for ${path}`, res?.status ?? null);
        } else {
          failure = new CallFailed("network", `DummyJSON request failed for ${path}`);
          retryable = true;
        }
      }
      record({ status: res?.status ?? null, ms: now() - started, attempt, cacheHit: false, stale: false });
      if (!retryable || attempt === 2) break;
      const wait = retryWait(res);
      if (ctx.budget.remaining() < wait + MIN_ATTEMPT_MS) break;
      await sleep(wait);
    }

    if (cached) {
      ctx.trace.event("catalog_stale", { path, reason: failure?.message ?? "failed" });
      record({ status: null, ms: 0, attempt: 0, cacheHit: true, stale: true });
      return cached.value;
    }
    throw failure ?? new CallFailed("network", `DummyJSON request failed for ${path}`);
  }

  async function list(path: string, ctx: CallCtx): Promise<{ products: RawProduct[]; total: number; endpoint: string }> {
    const body = (await get(path, ctx)) as ListBody;
    if (!body || !Array.isArray(body.products)) throw new CallFailed("parse", `Unexpected list shape for ${path}`);
    return { products: body.products, total: body.total ?? body.products.length, endpoint: path };
  }

  return {
    async byCategory(slug, ctx) {
      const { products, endpoint } = await list(`/products/category/${encodeURIComponent(slug)}?limit=0&${SELECT}`, ctx);
      return { products, endpoint };
    },
    async search(q, ctx) {
      const { products, endpoint } = await list(`/products/search?q=${encodeURIComponent(q)}&limit=0&${SELECT}`, ctx);
      return { products, endpoint };
    },
    async all(ctx) {
      const { products, endpoint } = await list(`/products?limit=0&${SELECT}`, ctx);
      return { products, endpoint };
    },
    async product(id, ctx) {
      return (await get(`/products/${id}`, ctx)) as RawProductFull;
    },
    async categories(ctx) {
      const body = await get("/products/categories", ctx);
      if (!Array.isArray(body)) throw new CallFailed("parse", "Unexpected categories shape");
      return (body as CategoryInfo[]).map((c) => ({ slug: c.slug, name: c.name }));
    },
  };
}
