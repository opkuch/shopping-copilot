// What a product IS, by category, for nouns whose products often don't say the word.
// "dress" matches 1 of the 5 womens-dresses by title, and the catalog's "tops" are all dresses and
// frocks; "watch" misses "Rolex Datejust". A product therefore matches the noun when its title or
// tags have the word OR its category is one of these. Keys are singular, as everywhere after normalizing.
// Only nouns that every product in the listed categories really is: "necklace" is not mapped to
// womens-jewellery (it holds only earrings), "sneaker" not to mens-shoes (it holds cleats). Those
// nouns match by title and tags instead.
import type { Gender, Slug } from "../messages/schema.ts";

export const NOUN_CATEGORIES: Record<string, Slug[]> = {
  dress: ["womens-dresses", "tops"],
  frock: ["tops", "womens-dresses"],
  watch: ["mens-watches", "womens-watches"],
  shoe: ["mens-shoes", "womens-shoes"],
  footwear: ["mens-shoes", "womens-shoes"],
  shirt: ["mens-shirts"],
  tshirt: ["mens-shirts"],
  jewellery: ["womens-jewellery"],
  jewelry: ["womens-jewellery"],
  bag: ["womens-bags"],
};

/** The category prefix a gender rules out: "men's watch" excludes "womens-" and vice versa. */
export function excludedPrefix(gender: Gender | null): string | null {
  return gender === null ? null : gender === "mens" ? "womens-" : "mens-";
}

/**
 * Categories that are this noun, minus the other gender's. Unisex categories stay: the catalog's
 * dresses live in "tops" as well as "womens-dresses".
 */
export function nounCategories(noun: string | null, gender: Gender | null): Slug[] {
  if (noun === null) return [];
  const all = NOUN_CATEGORIES[noun] ?? [];
  const excluded = excludedPrefix(gender);
  return excluded === null ? all : all.filter((slug) => !slug.startsWith(excluded));
}
