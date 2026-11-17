import type { Gender, Slug } from "../messages/schema.ts";
import { singularize, tokenize } from "./normalize.ts";

// Gender words choose between "mens-" and "womens-" categories. They are pulled out of the
// attributes into Query.gender: product copy rarely says "men", so as text they only empty results,
// and as soft words they were dropped on relaxation and printed in sentences ("running men shoes").
const GENDER: Record<string, Gender> = {
  men: "mens", man: "mens", male: "mens", mens: "mens", boy: "mens", him: "mens",
  women: "womens", woman: "womens", female: "womens", womens: "womens", lady: "womens",
  girl: "womens", her: "womens",
};

// Words for a child say who a product is for, not what it is. No product in the catalog says "kid",
// so as text they emptied every search ("I couldn't find kid balls"). They are dropped here, and only
// steer a gift (purpose.ts). Singular forms, as normalizeWords produces them ("babies" -> "baby").
export const KID_WORDS = new Set(["kid", "child", "children", "toddler", "baby", "infant", "teen", "teenage", "teenager"]);

/** Splits normalized attribute words into the gender they name (first one wins) and the rest, without words for a child. */
export function splitGender(words: string[]): { gender: Gender | null; rest: string[] } {
  let gender: Gender | null = null;
  const rest: string[] = [];
  for (const w of words) {
    const g = GENDER[w];
    if (g !== undefined) gender ??= g;
    else if (!KID_WORDS.has(w)) rest.push(w);
  }
  return { gender, rest };
}

// Every product in the slug is this thing, so the word is redundant once the slug is chosen.
// Keys are singular because lookup happens after singularizing ("groceries" -> "grocery").
export const SYNONYMS: Record<string, Slug> = {
  phone: "smartphones", smartphone: "smartphones",
  laptop: "laptops", notebook: "laptops",
  perfume: "fragrances", cologne: "fragrances", fragrance: "fragrances",
  tablet: "tablets",
  sunglass: "sunglasses", shade: "sunglasses",
  motorcycle: "motorcycle", motorbike: "motorcycle",
  grocery: "groceries",
  bag: "womens-bags", handbag: "womens-bags", purse: "womens-bags",
  // The category's own name. Without these, "skin care" was searched as the word "care", which no
  // product title has, and the turn ended in a miss labelled "Cares" over three skin-care products.
  "skin care": "skin-care", skincare: "skin-care",
  "home decoration": "home-decoration", "home decor": "home-decoration", decoration: "home-decoration", decor: "home-decoration",
  furniture: "furniture",
  makeup: "beauty", cosmetic: "beauty",
  car: "vehicle", vehicle: "vehicle",
  "sports equipment": "sports-accessories", "sports accessory": "sports-accessories",
  "kitchen accessory": "kitchen-accessories", "kitchen item": "kitchen-accessories", kitchenware: "kitchen-accessories",
};

// The word names a subtype or brand inside the slug, so it stays in the filter.
// Without this split "headphones" would become a page of chargers.
export const HINTS: Record<string, Slug> = {
  headphone: "mobile-accessories", earphone: "mobile-accessories", earbud: "mobile-accessories",
  airpod: "mobile-accessories", charger: "mobile-accessories",
  iphone: "smartphones", ipad: "tablets",
};

export function resolveCategory(args: {
  category: Slug | null;
  noun: string | null;
  attributes: string[];
  utterance: string;
  /** On a refine: the stored category when an earlier turn stated it. It stays stated while unchanged. */
  previouslyStated?: Slug | null;
}): { category: Slug | null; noun: string | null; attributes: string[]; categoryStated: boolean } {
  const { utterance } = args;
  let category = args.category;
  if (category === null && args.noun !== null) {
    category = SYNONYMS[args.noun] ?? HINTS[args.noun] ?? null;
  }
  // "An iPhone at a similar price" came back as attribute "iphone" with no noun: the hint still applies.
  if (category === null && args.noun === null) {
    for (const a of args.attributes) {
      const hinted = HINTS[a];
      if (hinted !== undefined) { category = hinted; break; }
    }
  }
  if (category === null) {
    return { category: null, noun: args.noun, attributes: args.attributes, categoryStated: false };
  }
  const chosen = category;
  const isSynonym = (w: string) => SYNONYMS[w] === chosen;
  const noun = args.noun !== null && isSynonym(args.noun) ? null : args.noun;
  const attributes = args.attributes.filter((a) => !isSynonym(a));

  // The extracted words count as what the user said: the extractor may name the category in its own
  // words ("phone" for "mobile"), and that is still the user stating it.
  const tokens = new Set([...tokenize(utterance), ...(args.noun === null ? [] : [args.noun]), ...args.attributes]);
  const slugWords = chosen.split("-").map(singularize);
  const categoryStated =
    [...tokens].some(isSynonym) || slugWords.every((w) => tokens.has(w)) || args.previouslyStated === chosen;
  return { category, noun, attributes, categoryStated };
}
