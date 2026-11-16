// Per-product search words and gender, written offline by scripts/enrich-catalog.ts and reviewed like
// code. Keyed by DummyJSON id; a product the file doesn't know (the catalog changed) simply has none,
// and matches on its own title and tags as before.
import { readFileSync } from "node:fs";
import type { Gender } from "../messages/schema.ts";
import { tokenize } from "../slots/normalize.ts";

type Entry = { gender: Gender | "unisex" | "none"; keywords: string[] };
type File = { products: Record<string, Entry> };

const FILE = JSON.parse(readFileSync(new URL("./enrichment.json", import.meta.url), "utf8")) as File;

export type Enrichment = {
  gender: Gender | null;
  /** Whole keywords, normalized: "earbud", "living room". */
  keywords: string[];
  /**
   * What the product IS: the last word of each keyword ("golf club" -> club, "face moisturizer" ->
   * moisturizer, "earbud"). Reviewed so no head names a different product (a cup's "hot drink" was removed).
   */
  heads: string[];
  /** Every token of every keyword, for descriptive words ("living", "room", "tennis"). */
  tokens: string[];
};

const NONE: Enrichment = { gender: null, keywords: [], heads: [], tokens: [] };
const cache = new Map<number, Enrichment>();

export function enrichmentOf(id: number): Enrichment {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const entry = FILE.products[String(id)];
  const value: Enrichment = entry === undefined ? NONE : {
    gender: entry.gender === "mens" || entry.gender === "womens" ? entry.gender : null,
    keywords: entry.keywords.map((k) => tokenize(k).join(" ")).filter((k) => k !== ""),
    heads: entry.keywords.map((k) => tokenize(k).at(-1)).filter((h): h is string => h !== undefined),
    tokens: entry.keywords.flatMap(tokenize),
  };
  cache.set(id, value);
  return value;
}
