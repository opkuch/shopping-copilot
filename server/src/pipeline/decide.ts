// The turn's policy: what the router's answers mean, given what is on screen. Pure: no model, no store,
// no catalog. Every guard that overrides the router lives here, in order, so a table test can lock it
// (test/decide.test.ts). runTurn.ts carries out the action this returns.
//
// The rule for overriding the model: the router proposes, and code overrides it only for a phrasing where
// the router was measured to fail (each regex below names the case), never to guess ahead of the evals.
import type { ExtractedIntent, ProductCard, RouterResult, TargetGroup } from "../messages/schema.ts";
import { superlativeSort } from "./merge.ts";

// "Show more" said in so many words, for when the router reads it as a refine or a reference.
export const MORE_RE = /^(?:(?:תראה|הראה|תראי|תן|תני)\s+(?:לי\s+)?עוד(?:\s+\S+)?|עוד(?:\s+(?:תוצאות|אפשרויות))?|show\s+(?:me\s+)?more(?:\s+\S+)?|more(?:\s+results)?|next(?:\s+ones)?)[.!?]*$/i;
// Asking about something rather than for something: "tell me about the Longines", in Hebrew too.
export const DETAIL_RE = /(?:ספר|תספר|תספרי|ספרי)\s+לי\s+(?:עוד\s+)?על|פרטים\s+על|tell\s+me\s+(?:more\s+)?about|details\s+(?:on|about|of)/i;

// The whole search, not the cards on screen: "out of all 15", "of them all", "overall", "not just these", "מכולם".
export const WHOLE_SET_RE = /\b(?:of|out\s+of|among|from)\s+(?:all|them\s+all|everything|every\s+one)\b|\boverall\b|\bnot\s+just\s+(?:these|those|the\s+ones)|מכולם|מכל\s+ה|בסך\s+הכל|לא\s+רק\s+(?:אלה|אלו|האלה|מה\s+שמוצג)/i;

// "Something else", "not earrings", "לא תכשיטים": a deterministic backup for the router's `reject`, applied
// only when extraction named no product (rejectsByWords), so "not earrings, a watch" stays a watch search.
export const REJECT_RE = /משהו אחר|דבר אחר|^לא\s|\sלא\s(?!יותר)|something else|anything else|^not\s|\bnot\s+(?:the\s+)?(?:earring|jewel|watch|perfume|bag|shoe)/i;

/** The backup: the words reject what is shown and the extraction names no product. Needs extraction, so runTurn applies it. */
export const rejectsByWords = (intent: ExtractedIntent, text: string) =>
  intent.noun === null && intent.category === null && REJECT_RE.test(text.trim());

export type TemplateReason =
  | "router_refused" | "service" | "catalog_overview" | "off_topic" | "greeting" | "refer_no_cards" | "refer_unclear";

export type TurnAction =
  | { kind: "template"; reason: TemplateReason }
  | { kind: "more" }
  | { kind: "refer"; target: number }
  /** A refine with two searches on screen and no word on which: ask, unless the change fits both (needs extraction). */
  | { kind: "which_group" }
  | {
    kind: "product";
    act: "new_search" | "refine";
    targetGroup: TargetGroup;
    /** This message answers "Which one should I change?": apply the change stored with the question. */
    answersPending: boolean;
    /** This message answers a clarifying question ("a gift: for whom?"): read it with that purpose. */
    answersQuestion: boolean;
    /** "Something else", "not earrings": back to the conversation's purpose without the kinds on screen. */
    rejectShown: boolean;
  };

export type DecideInput = {
  router: RouterResult;
  text: string;
  /** The cards on screen, flattened across groups, in display order. */
  shown: ProductCard[];
  /** Searches on screen (0, 1 or 2). */
  groupCount: number;
  /** The last reply asked a clarifying question with a purpose. */
  hasPurpose: boolean;
  /** The last reply asked which of two searches to change. */
  hasPending: boolean;
  /** Each search on screen: its sort, how many products matched, how many cards are shown. */
  groups?: Array<{ sort: string; total: number; shown: number }>;
};

/** Why the router's answer was overridden, for the turn trace. */
export type DecideNotes = {
  purposeApplied?: true;
  referByName?: number;
  pendingApplied?: { targetGroup: TargetGroup; routerAct: RouterResult["act"] };
  effectiveAct?: "new_search" | "refine";
};

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
  const { text, shown, groupCount, hasPurpose, hasPending } = input;
  let r = input.router;
  const notes: DecideNotes = {};
  const done = (action: TurnAction) => ({ action, notes });

  // A refusal comes first because its act and domain are not real answers.
  if (r.refused) return done({ kind: "template", reason: "router_refused" });
  // "For him" or "up to $100" right after the question is an answer, whatever the router made of
  // those few words (it tends to say chat or off topic).
  const answersQuestion = hasPurpose && r.domain !== "service";
  if (answersQuestion) notes.purposeApplied = true;
  // About the cards on screen ("tell me about it", "show more"): the domain question cannot see the
  // cards and tends to say off topic, so it does not decide these.
  const aboutShown = shown.length > 0 && (r.act === "refer" || r.act === "more" || r.act === "reject");
  // Service before chat: "can you deliver tomorrow?" and "where is my order?" were answered with a
  // greeting because the chat check came first.
  if (r.domain === "service" && !aboutShown && !answersQuestion) return done({ kind: "template", reason: "service" });
  if (r.act === "chat" && !answersQuestion) {
    if (r.chatKind === "catalog_overview") return done({ kind: "template", reason: "catalog_overview" });
    if (r.chatKind === "other" || (r.domain === "off_topic" && r.chatKind !== "greeting")) return done({ kind: "template", reason: "off_topic" });
    return done({ kind: "template", reason: "greeting" });
  }
  if (r.domain === "off_topic" && !answersQuestion && !aboutShown) return done({ kind: "template", reason: "off_topic" });

  // "Something else", "not earrings": what is on screen is turned down. With nothing on screen there is
  // nothing to turn down, and it is a search like any other.
  if (r.act === "reject" && !answersQuestion && groupCount > 0) {
    notes.effectiveAct = "new_search";
    return done({ kind: "product", act: "new_search", targetGroup: "unclear", answersPending: false, answersQuestion: false, rejectShown: true });
  }

  // "Show more": the next page of each search on screen.
  if (!answersQuestion && groupCount > 0 && (r.act === "more" || MORE_RE.test(text.trim()))) {
    return done({ kind: "more" });
  }
  // "Tell me about the Longines": the router called it a new search but picked a shown card, and the
  // message asks about it rather than for something.
  if (r.act === "new_search" && typeof r.referTarget === "number" && DETAIL_RE.test(text)) {
    notes.referByName = r.referTarget;
    r = { ...r, act: "refer" };
  }

  const targetGroup = r.targetGroup ?? "unclear";
  // An answer to "Which one should I change?" names a search ("the laptops", "both"). Whatever act
  // the router picked for those few words (it tends to say refer), it is the refine that was asked about.
  const answersPending = hasPending && groupCount === 2 && targetGroup !== "unclear";
  if (answersPending) notes.pendingApplied = { targetGroup, routerAct: r.act };

  // "Which one is the highest rated out of all 15?": the user asks about the whole search, and the shown
  // cards are only a page of it in another order, so the answer is the whole search re-sorted. Only when
  // the words say "of all": a plain "I want the cheapest one" still picks a shown card.
  const sup = superlativeSort(text);
  if (r.act === "refer" && typeof r.referTarget !== "number" && sup !== null && WHOLE_SET_RE.test(text) &&
      (input.groups ?? []).some((g) => g.total > g.shown && g.sort !== sup)) r = { ...r, act: "refine" };
  if (r.act === "refer" && !answersPending && !answersQuestion) {
    if (shown.length === 0) return done({ kind: "template", reason: "refer_no_cards" });
    // "I want the cheapest one" names no position and no title, so the router says unclear; the shown
    // prices and ratings answer it. "Tell me about it" with a single card on screen means that card.
    const target = typeof r.referTarget === "number" ? r.referTarget
      : superlativeCard(text, shown) ?? (shown.length === 1 ? 1 : null);
    if (target === null || target < 1 || target > shown.length) return done({ kind: "template", reason: "refer_unclear" });
    return done({ kind: "refer", target });
  }

  // What is left is a search. A change ("refine", or a "more" that could not be served above) needs a
  // search on screen to change; with none it is a new search ("more" with nothing on screen used to fail the turn).
  const act: "new_search" | "refine" =
    answersQuestion ? "new_search"
    : answersPending || r.act === "refer" ? "refine"
    : r.act === "new_search" || groupCount === 0 ? "new_search"
    : "refine";
  notes.effectiveAct = act;
  // "And something under $30?" with two searches on screen: runTurn infers "both" for a limit with no
  // product named; anything else asks which.
  if (act === "refine" && groupCount === 2 && targetGroup === "unclear") return done({ kind: "which_group" });
  return done({ kind: "product", act, targetGroup, answersPending, answersQuestion, rejectShown: false });
}
