// The turn's policy: what the router's answers mean, given what is on screen. Pure: no model, no store,
// no catalog. Every guard that overrides the router lives here, in order, so a table test can lock it
// (test/decide.test.ts). runTurn.ts carries out the action this returns.
//
// The rule for overriding the model: the router proposes, and code overrides it only for a phrasing where
// the router was measured to fail (each regex below names the case), never to guess ahead of the evals.
import type { PendingChange, ProductCard, RouterResult } from "../messages/schema.ts";
import { superlativeSort } from "./merge.ts";

// "Show more" said in so many words, for when the router reads it as a refine or a reference. Only a closed
// set of trailing words: "show me more expensive" or "show more red" changes the search, and is the router's call.
export const MORE_RE = /^(?:show\s+(?:me\s+)?more|more|next)(?:\s+(?:results|options|ones|of\s+these|of\s+them|like\s+(?:this|these)|please))?[.!?]*$/i;
// Asking about something rather than for something: "tell me about the Longines". The router read these as a
// new search 3 times in 7 while still picking the right card.
export const DETAIL_RE = /\btell\s+me\s+(?:more\s+)?about\b|\bdetails\s+(?:on|about|of)\b/i;

// A position the user names ("the second one", "#3"), to catch one past the cards on screen.
// "The second" or "second one", not "a second phone case".
const ordinal = (words: string) => new RegExp(String.raw`\bthe\s+(?:${words})\b|\b(?:${words})\s+one\b`, "i");
const ORDINALS: Array<[RegExp, number]> = [
  [ordinal("first|1st"), 1], [ordinal("second|2nd"), 2], [ordinal("third|3rd"), 3],
  [ordinal("fourth|4th"), 4], [ordinal("fifth|5th"), 5], [ordinal("sixth|6th"), 6],
];
export function namedPosition(text: string): number | null {
  const hash = /(?:#|\bnumber\s+|\bno\.\s*)(\d{1,2})\b/i.exec(text);
  if (hash) return Number(hash[1]);
  for (const [re, n] of ORDINALS) if (re.test(text)) return n;
  return null;
}

export type TemplateReason =
  | "router_refused" | "service" | "catalog_overview" | "off_topic" | "greeting" | "refer_no_cards" | "refer_unclear" | "remove_only";

/** Which search on screen an action is for: its 1-based position, or every one. */
export type Target = number | "all";

export type TurnAction =
  | { kind: "template"; reason: TemplateReason }
  /** The next cards of one search ("swap #2", "other options for the sunscreen"), or of every search. */
  | { kind: "more"; target: Target }
  /** One shown card: its details, and a reply to what was asked about it. */
  | { kind: "refer"; target: number }
  /** About the shown cards but no single one ("compare them", "which is best for running?"): answered from their details. */
  | { kind: "answer" }
  /** One item off a list of searches ("remove the eggs"). */
  | { kind: "remove"; target: number }
  /** Several searches on screen and no word on which: ask once, and keep the change for the answer. */
  | { kind: "which_group"; op: PendingChange["op"] }
  | {
    kind: "product";
    act: "new_search" | "refine";
    /** Which search a refine changes. */
    targetGroup: Target;
    /** "Something else", "not earrings": back to the conversation's purpose without the kinds on screen. */
    rejectShown: boolean;
    /** This message answers "Which one should I change?": apply the change stored with the question. */
    answersPending: boolean;
  };

export type DecideInput = {
  router: RouterResult;
  text: string;
  /** The cards on screen, flattened across groups, in display order. */
  shown: ProductCard[];
  /** Searches on screen (0 to MAX_GROUPS). */
  groupCount: number;
  /** The last reply asked which search to change, and stored this kind of change for the answer. */
  pending?: PendingChange["op"] | null;
};

/** Why the router's answer was overridden, for the turn trace. */
export type DecideNotes = { referByName?: number; effectiveAct?: "new_search" | "refine"; pendingApplied?: Target };

/** The 1-based position of the cheapest / dearest / best-rated shown card, when the message asks for one. */
export function superlativeCard(text: string, shown: ProductCard[]): number | null {
  const sort = superlativeSort(text);
  if (sort === null || shown.length === 0) return null;
  const key = (p: ProductCard) => (sort === "price_asc" ? -p.price : sort === "price_desc" ? p.price : p.rating);
  let best = 0;
  shown.forEach((p, i) => { if (key(p) > key(shown[best] as ProductCard)) best = i; });
  return best + 1;
}

export function decideAction(input: DecideInput): { action: TurnAction; notes: DecideNotes } {
  const { text, shown, groupCount } = input;
  let r = input.router;
  const notes: DecideNotes = {};
  const done = (action: TurnAction) => ({ action, notes });
  const product = (act: "new_search" | "refine", targetGroup: Target, extra: Partial<Extract<TurnAction, { kind: "product" }>> = {}): TurnAction =>
    ({ kind: "product", act, targetGroup, rejectShown: false, answersPending: false, ...extra });
  // Which search the router picked, when that is one on screen or every one.
  const picked: Target | null = r.targetGroup === "all" ? "all"
    : typeof r.targetGroup === "number" && r.targetGroup >= 1 && r.targetGroup <= groupCount ? r.targetGroup : null;

  // A refusal comes first because its act and domain are not real answers.
  if (r.refused) return done({ kind: "template", reason: "router_refused" });
  // An answer to "Which one should I change?" names a search ("the sunscreen", "#2"). Whatever act the router
  // picked for those few words (it tends to say refer or chat), it is the change that was asked about.
  if (input.pending && groupCount >= 2 && picked !== null) {
    notes.pendingApplied = picked;
    if (input.pending === "remove" && picked !== "all") return done({ kind: "remove", target: picked });
    if (input.pending === "refine") return done(product("refine", picked, { answersPending: true }));
  }
  // About the cards on screen ("tell me about it", "show more"): the domain question cannot see the
  // cards and tends to say off topic, so it does not decide these.
  const aboutShown = shown.length > 0 && (r.act === "refer" || r.act === "more" || r.act === "reject" || r.act === "remove");
  // Service before chat: "can you deliver tomorrow?" and "where is my order?" were answered with a
  // greeting because the chat check came first.
  if (r.domain === "service" && !aboutShown) return done({ kind: "template", reason: "service" });
  if (r.act === "chat") {
    if (r.chatKind === "catalog_overview") return done({ kind: "template", reason: "catalog_overview" });
    if (r.chatKind === "other" || (r.domain === "off_topic" && r.chatKind !== "greeting")) return done({ kind: "template", reason: "off_topic" });
    return done({ kind: "template", reason: "greeting" });
  }
  if (r.domain === "off_topic" && !aboutShown) return done({ kind: "template", reason: "off_topic" });

  // "Something else", "not earrings": what is on screen is turned down. With nothing on screen there is
  // nothing to turn down, and it is a search like any other.
  if (r.act === "reject" && groupCount > 0) {
    notes.effectiveAct = "new_search";
    return done(product("new_search", "all", { rejectShown: true }));
  }

  // "Remove the eggs": one item off a list. The last search on screen can't be removed, only replaced.
  if (r.act === "remove" && groupCount > 0) {
    if (groupCount === 1) return done({ kind: "template", reason: "remove_only" });
    return done(typeof picked === "number" ? { kind: "remove", target: picked } : { kind: "which_group", op: "remove" });
  }

  // "Show more": the next page of the search named ("swap #2"), else of every search on screen.
  if (groupCount > 0 && (r.act === "more" || MORE_RE.test(text.trim()))) return done({ kind: "more", target: picked ?? "all" });

  // "Tell me about the Longines": the router called it a new search but picked a shown card, and the
  // message asks about it rather than for something.
  if (r.act === "new_search" && typeof r.referTarget === "number" && DETAIL_RE.test(text)) {
    notes.referByName = r.referTarget;
    r = { ...r, act: "refer" };
  }

  if (r.act === "refer") {
    if (shown.length === 0) return done({ kind: "template", reason: "refer_no_cards" });
    // "The second one" with one card on screen: say so, never describe the first one instead.
    const position = namedPosition(text);
    if (position !== null && position > shown.length) return done({ kind: "template", reason: "refer_unclear" });
    // "I want the cheapest one" names no position and no title, so the router says unclear; the shown
    // prices and ratings answer it. "Tell me about it" with a single card on screen means that card.
    const target = typeof r.referTarget === "number" ? r.referTarget
      : superlativeCard(text, shown) ?? (shown.length === 1 ? 1 : null);
    if (target !== null && target >= 1 && target <= shown.length) return done({ kind: "refer", target });
    return done({ kind: "answer" });
  }

  // What is left is a search. A change needs a search on screen to change; with none it is a new search.
  const act: "new_search" | "refine" = r.act === "new_search" || groupCount === 0 ? "new_search" : "refine";
  notes.effectiveAct = act;
  // A change with several searches on screen and no word on which: ask once (runTurn first checks whether
  // it is a limit that fits every search, "anything under $30", which needs no question).
  if (act === "refine" && groupCount >= 2 && picked === null) return done({ kind: "which_group", op: "refine" });
  return done(product(act, picked ?? "all"));
}
