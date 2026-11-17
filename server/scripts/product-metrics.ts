// Pure scoring for the product eval (scripts/eval-product.ts). No I/O.
// It scores what the user got (the action taken, the cards shown, the reply), not what a model returned.

export type Action =
  | "results" | "miss" | "detail" | "more" | "answer" | "remove" | "clarify" | "ask_group"
  | "service" | "chat" | "off_topic" | "refused" | "dead_end" | "error";

export type Forbidden = { categories?: string[]; maxPrice?: number; minPrice?: number };

export type QueryCase = {
  id: string; author: string; text: string; expect: Action;
  relevant: number[]; forbidden: Forbidden; notes?: string;
  /** A superlative ("the cheapest Samsung"): this product must be the first card; the others are runners-up. */
  first?: number;
  /** Other actions that are just as good ("a gift": results or a question). */
  acceptAlso?: Action[];
};
export type DialogueTurn = {
  text: string; expect: Action; relevant?: number[]; forbidden?: Forbidden; detailId?: number; first?: number; acceptAlso?: Action[]; notes?: string;
};
export type Dialogue = { id: string; author: string; title?: string; turns: DialogueTurn[] };
export type VagueCase = {
  /** coherent: a set from the allowed categories; searched: results or an honest miss, never a question. */
  id: string; author: string; text: string; expect: "clarify" | "coherent" | "searched"; allowedCategories: string[]; notes?: string;
};

export type Card = { id: number; title: string; price: number; category: string };

/** What one turn produced, read from the HTTP response and the stored trace. */
export type Observed = {
  status: number;
  action: Action;
  cards: Card[]; // every group's cards, in screen order
  groupCount: number;
  detailId: number | null;
  reply: string;
  replyBy: "model" | "template" | "none";
  totalMs: number | null;
  cardsMs: number | null; // when the last catalog/retrieval step finished: the earliest cards could show
  writerMs: number | null;
};

type TraceEvent = { kind: string; atMs: number; data: Record<string, unknown> };
type Trace = {
  action?: string; template?: string; referCardId?: number; reply?: string; totalMs?: number;
  queries?: Array<{ fetched: boolean }>; groups?: Array<{ status: string }>; events?: TraceEvent[];
};

const TEMPLATE_ACTION: Record<string, Action> = {
  greeting: "chat", catalog_overview: "chat", service: "service", off_topic: "off_topic",
  router_refused: "refused", extraction_refused: "refused", ask_which_group: "ask_group",
  refer_unclear: "dead_end", refer_no_cards: "dead_end", remove_only: "dead_end",
};

/**
 * The action a turn took, as the user saw it. A trace may name it (`action`: more, answer, remove); otherwise it is derived from the template, a detail, or the groups.
 * A product turn whose every fetched group missed is a "miss", even when the earlier cards stayed.
 */
export function actionOf(status: number, trace: Trace | null, hasDetail: boolean): Action {
  if (status !== 200 || trace === null) return "error";
  if (typeof trace.action === "string") return trace.action as Action;
  if (trace.template !== undefined) return TEMPLATE_ACTION[trace.template] ?? "chat";
  if (hasDetail || trace.referCardId !== undefined) return "detail";
  const fetched = (trace.queries ?? []).filter((q) => q.fetched).length;
  const keptMisses = (trace.events ?? []).filter((e) => e.kind === "refine_kept_previous" && e.data.status === "miss").length;
  const misses = (trace.groups ?? []).filter((g) => g.status === "miss").length + keptMisses;
  return fetched > 0 && misses >= fetched ? "miss" : "results";
}

export function timingsOf(trace: Trace | null): Pick<Observed, "totalMs" | "cardsMs" | "writerMs"> {
  const events = trace?.events ?? [];
  const retrieval = events.filter((e) => e.kind === "retrieval" || e.kind === "catalog_request" || e.kind === "catalog_stale");
  const prose = events.find((e) => e.kind === "prose");
  return {
    totalMs: typeof trace?.totalMs === "number" ? trace.totalMs : null,
    cardsMs: retrieval.length > 0 ? Math.max(...retrieval.map((e) => e.atMs)) : null,
    writerMs: prose && typeof prose.data.ms === "number" ? prose.data.ms : null,
  };
}

export function violations(cards: Card[], f: Forbidden | undefined): Card[] {
  if (!f) return [];
  return cards.filter((c) =>
    (f.categories?.includes(c.category) ?? false) ||
    (f.maxPrice !== undefined && c.price > f.maxPrice) ||
    (f.minPrice !== undefined && c.price < f.minPrice));
}

/**
 * precision@shown: the share of cards shown that you labelled relevant.
 * recall@shown: relevant cards shown, out of as many as the screen could hold (4 per group, 3 in a list).
 * Both are null when the case has no relevant products (a miss, a service, a chat).
 */
export function relevance(cards: Card[], relevant: number[], groupCount: number): { precision: number | null; recall: number | null; hits: number } {
  if (relevant.length === 0) return { precision: null, recall: null, hits: 0 };
  const want = new Set(relevant);
  const hits = cards.filter((c) => want.has(c.id)).length;
  // the screen holds 4 cards a search, 3 once a shopping list puts three or more searches on it (pipeline/turn.ts)
  const capacity = (groupCount >= 3 ? 3 : 4) * Math.max(1, groupCount);
  return {
    precision: cards.length === 0 ? 0 : hits / cards.length,
    recall: hits / Math.min(relevant.length, capacity),
    hits,
  };
}

const cents = (n: number) => Math.round(n * 100);

export function amountsIn(text: string): number[] {
  const out: number[] = [];
  // "$50", "50$", "50 dollars", "50 bucks", "50 USD", "USD 50": the runtime guard (reply/compose.ts) reads the same forms.
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:\$|dollars?\b|bucks\b|usd\b)|\busd\s?(\d[\d,]*(?:\.\d+)?)/gi)) {
    const n = Number((m[1] ?? m[2] ?? m[3] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Facts a reply may not invent. A price must be a card's price, the detail's, or a number the user
 * typed. A catalog title of two or more words must be one of the cards shown (single-word titles such
 * as "Apple" or "Water" are ordinary words, so they are not checked).
 */
export function grounding(reply: string, shown: Card[], userText: string, catalogTitles: string[], detailPrice: number | null): {
  inventedPrices: number[]; inventedTitles: string[];
} {
  const allowed = new Set([...shown.map((c) => cents(c.price)), ...amountsIn(userText).map(cents), ...(detailPrice === null ? [] : [cents(detailPrice)])]);
  for (const m of userText.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    allowed.add(cents(n));
    // "around $300" is searched as $150-$375 (pipeline/merge.ts approximate), and a reply may say so
    allowed.add(cents(n * 0.5));
    allowed.add(cents(n * 1.25));
  }
  // "cheaper than $1099.99" is applied as a bound of $1099.98: a cent off a shown price is a fact, not an invention
  for (const c of [...allowed]) { allowed.add(c - 1); allowed.add(c + 1); }
  const inventedPrices = amountsIn(reply).filter((a) => !allowed.has(cents(a)));
  const lower = reply.toLowerCase();
  const shownTitles = new Set(shown.map((c) => c.title.toLowerCase()));
  const inventedTitles = catalogTitles.filter((t) => {
    const lt = t.toLowerCase();
    return lt.includes(" ") && !shownTitles.has(lt) && lower.includes(lt) && !userText.toLowerCase().includes(lt) &&
      // a shown title that contains this one ("Rolex Datejust" inside "Rolex Datejust Women") is not invented
      ![...shownTitles].some((s) => s.includes(lt));
  });
  return { inventedPrices, inventedTitles };
}

/** One turn's verdict: did the user get the right kind of answer, the right cards, and no invented facts? */
export type TurnScore = {
  actionOk: boolean;
  deadEnd: boolean;
  precision: number | null;
  recall: number | null;
  forbiddenCards: number;
  inventedPrices: number;
  inventedTitles: number;
  pass: boolean;
};

export function scoreTurn(
  expect: { action: Action; relevant: number[]; forbidden?: Forbidden; detailId?: number; first?: number; acceptAlso?: Action[] },
  obs: Observed, userText: string, catalogTitles: string[], detail: Card | null,
  /** Cards still on screen from earlier turns: a reply may name them ("similar in price to the Realme C35"). */
  earlier: Card[] = [],
): TurnScore {
  const rel = relevance(obs.cards, expect.relevant, obs.groupCount);
  const bad = violations(obs.cards, expect.forbidden);
  // A detail turn shows one product: the reply may name it and quote its price.
  const g = grounding(obs.reply, [...obs.cards, ...(detail ? [detail] : []), ...earlier], userText, catalogTitles, detail?.price ?? null);
  const actionOk = (obs.action === expect.action || (expect.acceptAlso ?? []).includes(obs.action)) && (expect.detailId === undefined || obs.detailId === expect.detailId) &&
    (expect.first === undefined || obs.cards[0]?.id === expect.first);
  const deadEnd = obs.action === "dead_end" && expect.action !== "dead_end";
  const relevantEnough = rel.precision === null || (rel.precision >= 0.75 && (rel.recall ?? 0) >= 0.5);
  return {
    actionOk, deadEnd, precision: rel.precision, recall: rel.recall, forbiddenCards: bad.length,
    inventedPrices: g.inventedPrices.length, inventedTitles: g.inventedTitles.length,
    pass: actionOk && relevantEnough && bad.length === 0 && g.inventedPrices.length === 0 && g.inventedTitles.length === 0,
  };
}

/** A vague request passes by asking (clarify), by a coherent set (every card in an allowed category), or by a search. */
export function scoreVague(c: VagueCase, obs: Observed): { pass: boolean; reason: string } {
  if (c.expect === "searched") {
    return obs.action === "results" || obs.action === "miss" ? { pass: true, reason: "searched" } : { pass: false, reason: "expected a search, got " + obs.action };
  }
  if (c.expect === "clarify") {
    return obs.action === "clarify" ? { pass: true, reason: "asked" } : { pass: false, reason: `expected a clarifying question, got ${obs.action}` };
  }
  if (obs.action !== "results") return { pass: false, reason: `expected a coherent set, got ${obs.action}` };
  const off = obs.cards.filter((card) => c.allowedCategories.length > 0 && !c.allowedCategories.includes(card.category));
  return off.length === 0 ? { pass: true, reason: "coherent" } : { pass: false, reason: `off-theme: ${off.map((x) => `${x.title} [${x.category}]`).join(", ")}` };
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? null;
}

export const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
