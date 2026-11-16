import { DENYLIST } from "./denylist.ts";

// Irregular plurals a shopper types ("kitchen knives") that the suffix rules below would mangle.
const IRREGULAR: Record<string, string> = {
  knives: "knife", leaves: "leaf", shelves: "shelf", halves: "half", wives: "wife", mice: "mouse",
  // Not a plural, but the same word for search: "gold shoes" must find "Golden Shoes".
  golden: "gold",
};
// Stems whose singular ends in "-ie", not "-y": "cookies" is "cookie", not "cooky".
const IE_STEMS = new Set(["cook", "mov", "hood", "self", "smooth", "brown", "rook", "calor", "zomb"]);

// Naive on purpose: it is applied to queries and to catalog text alike, so an odd stem
// ("series" -> "sery") still matches itself.
export function singularize(word: string): string {
  const w = word.toLowerCase();
  const irregular = IRREGULAR[w];
  if (irregular !== undefined) return irregular;
  // "batteries" -> "battery", "accessories" -> "accessory"; "ties" and "pies" fall through to "-s".
  if (w.length > 4 && w.endsWith("ies")) {
    const stem = w.slice(0, -3);
    return IE_STEMS.has(stem) ? `${stem}ie` : `${stem}y`;
  }
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  // "-is" and "-us" are singular words, not plurals: "tennis" must not become "tenni".
  if (w.endsWith("s") && !/(ss|is|us)$/.test(w)) return w.slice(0, -1);
  return w;
}

// Splitting on non-alphanumerics turns "men's" into "men" + "s"; singularizing "s" gives "",
// which is dropped. So a lone possessive "s" disappears without a general rule that would
// also drop meaningful one-letter tokens ("c", "x" in model names).
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(singularize)
    .filter((t) => t.length > 0);
}

export function normalizeWord(w: string): string | null {
  // "men's" must become "men", not "men'" (which matches nothing).
  const lower = w.trim().toLowerCase().replace(/['’]s$/, "").replace(/['’]$/, "");
  if (lower === "") return null;
  const singular = singularize(lower);
  if (singular === "") return null;
  if (DENYLIST.has(lower) || DENYLIST.has(singular)) return null;
  return singular;
}

export function normalizeWords(ws: string[] | null): string[] | null {
  if (ws === null) return null;
  const out: string[] = [];
  for (const w of ws) {
    const n = normalizeWord(w);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}
