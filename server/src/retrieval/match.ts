import type { RawProduct } from "../pipeline/ports.ts";
import { enrichmentOf } from "../catalog/enrichment.ts";
import { tokenize } from "../slots/normalize.ts";

type Text = Pick<RawProduct, "title" | "description" | "tags"> & { id?: number };

const tagText = (p: Pick<RawProduct, "tags">) => (p.tags ?? []).join(" ");
const enriched = (p: { id?: number }) => (p.id === undefined ? null : enrichmentOf(p.id));

/** A brand as one normalized key ("Calvin Klein" -> "calvin klein"), so a brand word matches the whole brand only. */
export function brandKey(p: Pick<RawProduct, "brand">): string | null {
  if (!p.brand) return null;
  const key = tokenize(p.brand).join(" ");
  return key === "" ? null : key;
}

// Whole-token equality, not substring: "ring" must not hit "spring" or "fragrance",
// and "top" must not hit "laptops". Words are already singularized by the caller.
// A phrase ("nike air jordan", "living room") matches when every one of its words is there.
// Enrichment keywords count as text: "living room" finds the sofa, "tennis" the racket.
export function matchedWords(product: Text, words: string[]): string[] {
  if (words.length === 0) return [];
  const tokens = new Set([
    ...tokenize(`${product.title} ${product.description} ${tagText(product)}`),
    ...(enriched(product)?.tokens ?? []),
  ]);
  return words.filter((w) => tokenize(w).every((t) => tokens.has(t) || (agentPartner(t) !== null && tokens.has(agentPartner(t) as string))));
}

/**
 * "training" and "trainer" are one word for search ("training sneakers" must find the Trainers). Only the
 * -ing / -er pair is swapped, never the bare stem: "designer" -> "design" matched 54 products. The stem
 * keeps at least four letters, so "ring" and "string" stay whole words.
 */
export function agentPartner(word: string): string | null {
  if (word.endsWith("ing") && word.length - 3 >= 4) return `${word.slice(0, -3)}er`;
  if (word.endsWith("er") && word.length - 2 >= 4) return `${word.slice(0, -2)}ing`;
  return null;
}

export function matchesAll(product: Text, words: string[]): boolean {
  return matchedWords(product, words).length === words.length;
}

/**
 * The noun matches by the product's category being that kind of thing (nouns.ts), or by its title or
 * the head word of a tag, or by the head of an enrichment keyword ("earbud" for AirPods, "club" for Iron Golf's "golf
 * club"). Not by description, and not by a word in front of a head: "water" must not find a Rolex because
 * its copy says "water resistance", and "golf" is not what a golf club is.
 */
export function matchesNoun(product: Text & { category: string }, noun: string | null, categories: readonly string[]): boolean {
  if (noun === null) return true;
  if (categories.includes(product.category)) return true;
  if (titleIsNoun(product.title, noun)) return true;
  // A tag is a phrase too: "camera accessories" is an accessory, not a camera.
  if ((product.tags ?? []).some((t) => tokenize(t).at(-1) === noun)) return true;
  return enriched(product)?.heads.includes(noun) ?? false;
}

// Words that make the word before them a modifier: a "Camera Pedestal" is a pedestal, a "Basketball Rim"
// a rim, an "iPhone Charger" a charger. Measured: "reflex camera" showed the pedestal, "basketball" the rim.
const ACCESSORY_HEADS = new Set(["pedestal", "rim", "stand", "holder", "case", "cover", "charger", "strap", "mount", "tray", "rack", "stick"]);

/** The title names the noun as what the product is, not as what an accessory is for. */
function titleIsNoun(title: string, noun: string): boolean {
  const tokens = tokenize(title);
  return tokens.some((t, i) => t === noun && !ACCESSORY_HEADS.has(tokens[i + 1] ?? ""));
}

/** Whom the product is for, when the catalog makes it clear (a women's perfume in "fragrances"). */
export const productGender = (product: { id?: number }) => enriched(product)?.gender ?? null;

export function titleHits(product: Pick<RawProduct, "title">, words: string[]): number {
  const tokens = new Set(tokenize(product.title));
  return words.filter((w) => tokens.has(w)).length;
}
