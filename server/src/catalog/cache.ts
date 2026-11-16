import type { CallCtx, CatalogApi, CategoryInfo, CategoryNames } from "../pipeline/ports.ts";

export interface UrlCache {
  /** Entries past their TTL are still returned (fresh: false) so a failed fetch can serve them stale. */
  get(url: string): { value: unknown; fresh: boolean } | undefined;
  set(url: string, value: unknown): void;
}

export function createUrlCache(opts: { ttlMs: number; maxEntries: number; now: () => number }): UrlCache {
  const entries = new Map<string, { value: unknown; at: number }>();
  return {
    get(url) {
      const e = entries.get(url);
      if (!e) return undefined;
      return { value: e.value, fresh: opts.now() - e.at < opts.ttlMs };
    },
    set(url, value) {
      // delete first so re-setting moves the key to newest in Map insertion order
      entries.delete(url);
      entries.set(url, { value, at: opts.now() });
      while (entries.size > opts.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

export function createCategoryNames(api: CatalogApi, opts: { ttlMs: number; now: () => number }): CategoryNames {
  let list: CategoryInfo[] | null = null;
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;

  async function load(ctx: CallCtx): Promise<void> {
    try {
      list = await api.categories(ctx);
      loadedAt = opts.now();
    } catch (err) {
      // keep the last good list; the next call after this one tries again
      ctx.trace.event("category_names_failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    async names(ctx) {
      if (list === null || opts.now() - loadedAt >= opts.ttlMs) {
        inflight ??= load(ctx).finally(() => {
          inflight = null;
        });
        await inflight;
      }
      return list;
    },
  };
}
