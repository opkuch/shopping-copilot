// Opt-in live DummyJSON shape smoke (`npm run eval:catalog`). Not part of `npm test`.
// Checks the assumptions the retrieval adapter makes; it does not snapshot titles.
import { createBudget } from "../src/pipeline/budget.ts";
import type { CallCtx, CatalogApi } from "../src/pipeline/ports.ts";
import { CATEGORY_DESCRIPTIONS } from "../src/catalog/categories.ts";
import { SLUGS } from "../src/messages/schema.ts";

export type CatalogCheck = { name: string; pass: boolean; detail: string };
type Api = Pick<CatalogApi, "categories" | "search" | "byCategory">;

const SELECTED = ["id", "title", "description", "price", "thumbnail", "rating", "category", "stock"] as const;

export async function checkCatalog(api: Api, ctx: CallCtx = { budget: createBudget(60_000), trace: { event() {} } }): Promise<CatalogCheck[]> {
  const results: CatalogCheck[] = [];
  // A thrown call is a failed check, not a crash, so the other checks still report.
  const run = async (name: string, fn: () => Promise<{ pass: boolean; detail: string }>) => {
    try {
      results.push({ name, ...(await fn()) });
    } catch (err) {
      results.push({ name, pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  await run("list responses carry a products array with the selected fields", async () => {
    const { products } = await api.byCategory("laptops", ctx);
    if (!Array.isArray(products) || products.length === 0) return { pass: false, detail: "no products array for laptops" };
    const missing = SELECTED.filter((f) => products.some((p) => (p as Record<string, unknown>)[f] === undefined));
    return { pass: missing.length === 0, detail: missing.length === 0 ? `${products.length} laptops, all fields present` : `missing fields: ${missing.join(", ")}` };
  });

  await run("the 24 SLUGS equal the live /products/categories slugs", async () => {
    const live = new Set((await api.categories(ctx)).map((c) => c.slug));
    const ours = new Set<string>(SLUGS);
    const extra = [...live].filter((s) => !ours.has(s));
    const missing = [...ours].filter((s) => !live.has(s));
    return {
      pass: extra.length === 0 && missing.length === 0,
      detail: `live has ${live.size}; not in SLUGS: [${extra.join(", ")}]; in SLUGS but not live: [${missing.join(", ")}]`,
    };
  });

  await run("every slug has a category description", async () => {
    const lacking = SLUGS.filter((s) => !CATEGORY_DESCRIPTIONS[s]?.trim());
    return { pass: lacking.length === 0, detail: lacking.length === 0 ? "all described" : `no description: ${lacking.join(", ")}` };
  });

  await run("q is still phrase-matched", async () => {
    const forward = (await api.search("red lipstick", ctx)).products.length;
    const reversed = (await api.search("lipstick red", ctx)).products.length;
    return {
      pass: forward >= 1 && reversed === 0,
      detail: `search("red lipstick") = ${forward} (want >= 1), search("lipstick red") = ${reversed} (want 0)`,
    };
  });

  return results;
}

async function main(): Promise<void> {
  const { createDummyJsonApi } = await import("../src/retrieval/dummyjson.ts");
  const results = await checkCatalog(createDummyJsonApi({ baseUrl: "https://dummyjson.com" }));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

if (import.meta.main) await main();
