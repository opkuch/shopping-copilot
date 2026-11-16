// In-memory CatalogApi over test/fixtures/catalog.json that mirrors real DummyJSON semantics:
//  - search: the WHOLE q is one lowercase phrase, substring-matched on title or description
//  - byCategory: exact slug match; all: everything
//  - list responses carry only the selected fields (plus id), like `select=`
//
// Usage:
//   const api = createFixtureApi();
//   await api.search("ring", ctx);  api.calls  // [{ method: "search", arg: "ring" }]
//   api.failNext.byCategory = new CallFailed("network", "boom");   // fails the next byCategory call once
//   const api2 = createFixtureApi({ failWhen: (method, arg) => method === "all" ? new CallFailed("timeout", "t") : null });
//   api.reset();   // clears calls and pending failNext entries
import { readFileSync } from "node:fs";
import { CallFailed } from "../../src/pipeline/ports.ts";
import type {
  CallCtx, CatalogApi, CategoryInfo, RawProduct, RawProductFull,
} from "../../src/pipeline/ports.ts";

type Method = "byCategory" | "search" | "all" | "product" | "categories";
export type FixtureCall = { method: Method; arg: unknown };
export type FixtureApi = CatalogApi & {
  calls: FixtureCall[];
  failNext: Partial<Record<Method, CallFailed>>;
  reset(): void;
};

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

const FULL = read<RawProductFull[]>("catalog.json");
const CATEGORIES = read<Array<{ slug: string; name: string; url: string }>>("categories.json");

function select(p: RawProductFull): RawProduct {
  return {
    id: p.id, title: p.title, description: p.description, price: p.price,
    thumbnail: p.thumbnail, rating: p.rating, category: p.category, stock: p.stock,
    ...(p.brand === undefined ? {} : { brand: p.brand }),
    ...(p.tags === undefined ? {} : { tags: p.tags }),
    ...(p.discountPercentage === undefined ? {} : { discountPercentage: p.discountPercentage }),
  };
}

export function createFixtureApi(opts: { failWhen?: (method: Method, arg: unknown) => CallFailed | null } = {}): FixtureApi {
  const calls: FixtureCall[] = [];
  const failNext: Partial<Record<Method, CallFailed>> = {};

  function enter(method: Method, arg: unknown): void {
    calls.push({ method, arg });
    const pending = failNext[method];
    if (pending) {
      delete failNext[method];
      throw pending;
    }
    const failure = opts.failWhen?.(method, arg);
    if (failure) throw failure;
  }
  const list = (items: RawProductFull[]) => structuredClone(items.map(select));

  return {
    calls,
    failNext,
    reset() {
      calls.length = 0;
      for (const k of Object.keys(failNext) as Method[]) delete failNext[k];
    },
    async byCategory(slug, _ctx: CallCtx) {
      enter("byCategory", slug);
      return { products: list(FULL.filter((p) => p.category === slug)), endpoint: `/products/category/${slug}?limit=0` };
    },
    async search(q, _ctx) {
      enter("search", q);
      const needle = q.toLowerCase();
      const hits = FULL.filter((p) => p.title.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle));
      return { products: list(hits), endpoint: `/products/search?q=${encodeURIComponent(q)}&limit=0` };
    },
    async all(_ctx) {
      enter("all", null);
      return { products: list(FULL), endpoint: "/products?limit=0" };
    },
    async product(id, _ctx) {
      enter("product", id);
      const found = FULL.find((p) => p.id === id);
      if (!found) throw new CallFailed("http", `product ${id} not found`, 404);
      return structuredClone(found);
    },
    async categories(_ctx): Promise<CategoryInfo[]> {
      enter("categories", null);
      return CATEGORIES.map((c) => ({ slug: c.slug, name: c.name }));
    },
  };
}
