// A product search: new, refined, or a rejection of what is shown. Turns the extraction into at most two
// queries, fetches them in parallel, shows the cards as soon as they are decided, then has the reply written.
import { MAX_GROUPS } from "../../messages/schema.ts";
import type { ConversationMemory, ExtractedIntent, ExtractionResult, Group, PendingChange, Query, Suggestion } from "../../messages/schema.ts";
import * as T from "../../reply/templates.ts";
import type { TurnAction } from "../decide.ts";
import { intentToQuery, patchQuery, scopePrices } from "../merge.ts";
import { normalizeWord } from "../../slots/normalize.ts";
import { CallFailed } from "../ports.ts";
import type { ResultFacts, Retriever, TurnFlags, TurnOutcome } from "../ports.ts";
import { giftCategories, giftSuggestions, mentionsChild, narrowSuggestions, nextStepSuggestions, planPurpose, rejectionBrowse } from "../purpose.ts";
import { EMPTY_INTENT, asRepeat, cardsPerGroup, describe, isEmptyIntent, requestedQuery } from "../turn.ts";
import type { Settled, Turn } from "../turn.ts";

type Slot =
  | { kind: "fetch"; requested: Query; relative: T.RelativePrice | null; from: Group | null }
  | { kind: "keep"; group: Group };

type SearchAction = Extract<TurnAction, { kind: "product" }>;

/** Only names a product: no price, words, order, stock or exclusion, nothing to change ("the sunscreen"). */
const namesOnly = (i: ExtractedIntent) => isEmptyIntent({ ...i, noun: null, category: null });

/**
 * How a message read as the answer to "Which one should I change?" is taken:
 * - "stashed": it only names the item ("the sunscreen", "#2"), so the change stored with the question applies;
 * - "own": it states a change of its own ("the sunscreen, under $20"), which applies to the item named;
 * - "new_search": it names a different product and nothing else, so it is a new search, not an answer.
 */
export function pendingAnswer(own: ExtractedIntent[], target: Group | undefined): "stashed" | "own" | "new_search" {
  if (own.every(isEmptyIntent)) return "stashed";
  if (!own.every(namesOnly)) return "own";
  const first = own[0] as ExtractedIntent;
  const noun = first.noun === null ? null : normalizeWord(first.noun);
  const named = (noun !== null && target !== undefined && (noun === target.query.noun || target.label.toLowerCase().startsWith(noun)))
    || (first.category !== null && first.category === target?.query.category);
  return own.length === 1 && named ? "stashed" : "new_search";
}

/** A limit that fits every search: a price bound or stock wish, nothing product-specific, nothing relative. */
export async function appliesToAll(extracted: Promise<Settled<ExtractionResult>>): Promise<boolean> {
  const ex = await extracted;
  if (!ex.ok || ex.value.refused) return false;
  const intents = ex.value.extraction.intents;
  if (intents.length !== 1) return false;
  const i = intents[0] as ExtractedIntent;
  const limitOnly = i.priceMin !== null || i.priceMax !== null || i.inStock === true;
  return limitOnly && i.category === null && i.noun === null && (i.attributes ?? []).length === 0 && (i.exclude ?? []).length === 0 && i.relativePrice === null;
}

/**
 * "Make it cheaper" with several searches on screen and no word on which: ask once, one chip per search. The
 * question waits for extraction so the change it asks about is stored with it and applied to the search the
 * next message names.
 */
export async function askWhichGroup(t: Turn, stored: Group[], op: PendingChange["op"], extracted: Promise<Settled<ExtractionResult>>): Promise<TurnOutcome> {
  t.summary.template = "ask_which_group";
  let pending: PendingChange = { op: "remove" };
  if (op === "refine") {
    const ex = await extracted;
    pending = { op: "refine", intents: ex.ok && !ex.value.refused ? ex.value.extraction.intents.filter((i) => !isEmptyIntent(i)).slice(0, MAX_GROUPS) : [] };
  } else {
    t.extractAbort.abort();
  }
  const chips = stored.map((g) => ({ label: g.label, text: `the ${g.label.toLowerCase()}` }));
  return t.commit(T.whichGroup(stored.map((g) => g.label), op), { groups: [], detail: null, suggestions: chips, pending, ...(t.memory ? { memory: t.memory } : {}) });
}

/**
 * The groups on screen, in order, as the reply writer sees them. A displayed group that was fetched
 * this turn carries its outcome from `views`; a group kept from an earlier turn is just "results".
 * Card positions run across both groups, as "the second one" does.
 */
function resultFacts(shown: Group[], viewOf: Array<T.GroupView | null>): ResultFacts[] {
  let position = 0;
  return shown.map((group, i) => {
    const view = viewOf[i] ?? null;
    const fetched = view?.group ?? group;
    const requested = view?.requested ?? group.query;
    return {
      label: group.label,
      outcome: fetched.status === "results" ? "results" : fetched.status === "miss" ? "no_match" : "could_not_load",
      match: fetched.match,
      droppedWords: fetched.match === "attributes_relaxed" ? T.droppedAttributes(requested, fetched.query) : [],
      earlierCardsKept: view?.keptPrevious ?? false,
      totalMatches: fetched.total,
      request: {
        priceMin: requested.priceMin, priceMax: requested.priceMax, sort: requested.sort, inStockOnly: requested.inStock,
        topIsFirst: requested.top && requested.sort !== "relevance" && fetched.status === "results",
      },
      cards: group.products.map((p) => ({ position: ++position, title: p.title, category: p.category, price: p.price, rating: p.rating, inStock: p.inStock })),
    };
  });
}

/**
 * Whether a model sentence adds anything over the template. Not for a shopping list (its summary of what was found
 * and what wasn't is the designed reply) and not when every search found nothing ("I couldn't find a kettle in our
 * catalog" is the whole answer). Skipping the call there lands the full reply with the cards, about 1.7 s sooner.
 */
export function writerAdds(views: T.GroupView[]): boolean {
  return views.length < 3 && views.some((v) => v.group.status === "results");
}

export async function searchTurn(
  t: Turn, action: SearchAction, stored: Group[], extracted: Promise<Settled<ExtractionResult>>,
  opts: { mentionsService: boolean; pending: PendingChange | null; appliedToAll?: boolean },
): Promise<TurnOutcome> {
  const { summary, memory, text } = t;
  const ex = await extracted;
  if (!ex.ok) return t.failed("extraction_failed", ex.error);
  if (ex.value.refused) return t.template("extraction_refused", T.refusal());
  const extraction = ex.value.extraction;
  summary.extraction = extraction;

  // At most MAX_GROUPS intents, whatever the extractor sent. "The sunscreen" after "Which one should I change?" says
  // which search, not what to change: the change is the one stored with the question, unless this message states one.
  const own = extraction.intents.slice(0, MAX_GROUPS);
  const stashed = action.answersPending && opts.pending?.op === "refine" ? opts.pending.intents : null;
  const target = typeof action.targetGroup === "number" ? stored[action.targetGroup - 1] : undefined;
  const answer = stashed === null ? "none" : pendingAnswer(own, target);
  // A message that names another product instead of answering ("actually, show me phone cases") is a new
  // search, not the stored change applied to whichever item the router guessed.
  const act = answer === "new_search" ? "new_search" : action.act;
  if (answer === "new_search") t.trace.event("pending_ignored", { reason: "names another product" });
  const intents = answer === "stashed" ? (stashed as ExtractedIntent[]) : own;
  if (answer === "stashed") summary.pendingApplied = intents.length;
  const flags: TurnFlags = {
    droppedIntents: extraction.droppedIntentCount > 0,
    mentionsService: opts.mentionsService,
    currencyNotApplied: false,
    appliedToAll: opts.appliedToAll ?? false,
    noCheaper: false,
  };

  const names = t.loadNames(); // starts now, overlaps with the catalog fetches
  const slots: Slot[] = [];
  let suggestions: Suggestion[] = [];
  let nextMemory: ConversationMemory | null = memory;

  if (action.rejectShown && stored.length > 0) {
    // "Something else", "not earrings": back to the conversation's purpose (a gift for her) without the
    // kinds on screen. The price follows the same rule as a refine: "not jewelry" after "under $100" is
    // still under $100, while "something else, more expensive" replaces the range.
    const intent = intents[0] ?? EMPTY_INTENT;
    const rejected = [...new Set(stored.flatMap((g) => g.products.map((p) => p.category)))] as NonNullable<Query["category"]>[];
    const base = memory ?? { purpose: null, excluded: [] };
    const first = stored[0] as Group;
    const priceOnly = { ...EMPTY_INTENT, priceMin: intent.priceMin, priceMax: intent.priceMax, currency: intent.currency, relativePrice: intent.relativePrice, clear: intent.clear.filter((f) => f === "price") };
    const priced = patchQuery(first.query, priceOnly, text, first.products).query;
    const plan = rejectionBrowse(base, rejected, first.query.gender);
    summary.rejected = { rejected, within: plan.within };
    nextMemory = { purpose: base.purpose, excluded: plan.excluded };
    const made = intentToQuery({ ...intent, noun: null, category: null, attributes: null }, text).query;
    const query: Query = { ...made, gender: plan.gender, within: plan.within, purpose: plan.purpose, priceMin: priced.priceMin, priceMax: priced.priceMax };
    slots.push({ kind: "fetch", requested: query, relative: null, from: null });
    suggestions = narrowSuggestions();
  } else if (act === "new_search") {
    const list = intents.length > 0 ? scopePrices(intents, text) : [EMPTY_INTENT];
    if (list !== intents && intents.length > 0) summary.priceScoped = true;
    for (const intent of list) {
      const made = intentToQuery(intent, text);
      flags.currencyNotApplied ||= made.currencyNotApplied;
      let query = made.query;
      const plan = planPurpose(intent, query);
      if (plan !== null) {
        summary.purposePlan = plan;
        query = { ...query, attributes: [], within: plan.within, purpose: plan.purpose, gender: plan.gender };
        suggestions = plan.purpose === "gift" ? giftSuggestions({ gender: plan.gender, kid: plan.kid, priceMax: query.priceMax }) : narrowSuggestions();
      }
      // A gift is remembered until a search with no gift in it: then the purpose and the rejections end.
      if (plan?.purpose === "gift") nextMemory = { purpose: { gift: true, gender: plan.gender, kid: plan.kid }, excluded: [] };
      else if (intent.gift !== true) nextMemory = null;
      slots.push({ kind: "fetch", requested: query, relative: null, from: null });
    }
  } else {
    const all = action.targetGroup === "all";
    // "Laptops under 1500 and the perfume under 60": one patch per search, in order, goes one to each. The model
    // repeats one patch per search for "make them all cheaper", which is the same change each time.
    const perGroup = all && stored.length > 1 && intents.length === stored.length;
    const targets = all ? stored.map((_, i) => i) : [(action.targetGroup as number) - 1];
    stored.forEach((group, i) => {
      if (!targets.includes(i)) return void slots.push({ kind: "keep", group });
      const intent = (perGroup ? intents[i] : intents[0]) ?? EMPTY_INTENT;
      // A change starts from what the user asked for, not what a relaxed match kept: "under $100" after "black
      // leather handbag" (shown: a leather bag, no black one) still wants black. "Cheaper" is the exception: it
      // is measured from the cards shown, so it keeps to what they match.
      const relativeOnly = intent.relativePrice !== null;
      const patched = patchQuery(relativeOnly ? group.query : requestedQuery(group), intent, text, group.products);
      flags.currencyNotApplied ||= patched.currencyNotApplied;
      const relative: T.RelativePrice | null =
        patched.cheaperThan !== null ? { direction: "cheaper", price: patched.cheaperThan }
        : patched.pricierThan !== null ? { direction: "pricier", price: patched.pricierThan }
        : null;
      let query = patched.query;
      // A gift's categories come from whom it is for, so they are rebuilt on every change:
      // "for my mom" after "for my dad" gets her gift set, not his set under a women's filter.
      const purpose = memory?.purpose ?? null;
      if (query.purpose === "gift" && purpose?.gift) {
        const now = { gift: true, gender: query.gender, kid: purpose.kid || mentionsChild(intent) };
        const excluded = memory?.excluded ?? [];
        query = { ...query, within: giftCategories(now).filter((c) => !excluded.includes(c)) };
        nextMemory = { purpose: now, excluded };
      }
      slots.push({ kind: "fetch", requested: query, relative, from: group });
    });
  }
  summary.queries = slots.map((s) => (s.kind === "fetch" ? { fetched: true, query: s.requested, relative: s.relative } : { fetched: false }));

  // All fetches at once; one failure must not discard the other groups. A long list shows fewer cards per item.
  t.setStage("searching");
  const fetches = slots.filter((s): s is Extract<Slot, { kind: "fetch" }> => s.kind === "fetch");
  const pageSize = cardsPerGroup(slots.length);
  const settled = await Promise.allSettled(
    fetches.map((s) => t.deps.retriever.retrieve(s.requested, t.ctx, { exactOnly: s.relative !== null, pageSize })),
  );
  const categoryNames = await names;
  const anyNewResults = settled.some((o) => o.status === "fulfilled" && o.value.status === "results");

  let succeeded = 0;
  const views: T.GroupView[] = [];
  const groups: Group[] = [];
  const viewOf: Array<T.GroupView | null> = []; // per entry of `groups`: its view, null when kept unfetched
  let k = 0;
  for (const slot of slots) {
    if (slot.kind === "keep") {
      // Unchanged and already on screen above: carried as the working query, drawn as one line.
      groups.push(asRepeat(slot.group));
      viewOf.push(null);
      continue;
    }
    const outcome = settled[k++] as PromiseSettledResult<Awaited<ReturnType<Retriever["retrieve"]>>>;
    let group: Group;
    if (outcome.status === "fulfilled") {
      const res = outcome.value;
      succeeded++;
      group = {
        label: T.labelFor(res.applied, categoryNames), status: res.status, match: res.match, query: res.applied, products: res.products, total: res.total,
        ...(res.dropped !== undefined && res.dropped.length > 0 ? { dropped: res.dropped } : {}),
      };
    } else if (outcome.reason instanceof CallFailed) {
      const query = slot.requested;
      t.trace.event("group_unavailable", { query, ...describe(outcome.reason) });
      group = { label: T.labelFor(query, categoryNames), status: "unavailable", match: "none", query, products: [], total: 0 };
    } else {
      throw outcome.reason;
    }
    // A refine that finds nothing (or cannot load) keeps the cards on screen: the impossible query must not
    // become the working query, or "the second one" would point at nothing. Only when nothing in this turn
    // found anything: old cards must not stay under a sentence that says there are none.
    const previous = slot.from;
    const keepPrevious = group.status !== "results" && previous !== null && previous.products.length > 0 && !anyNewResults;
    if (keepPrevious) t.trace.event("refine_kept_previous", { status: group.status, relative: slot.relative, label: previous.label });
    const view: T.GroupView = { group, requested: slot.requested, relative: slot.relative, keptPrevious: keepPrevious };
    // The kept cards are already on screen in the message above: marked, so they are not drawn twice.
    groups.push(keepPrevious ? asRepeat(previous) : group);
    views.push(view);
    viewOf.push(view);
    if (group.status === "miss" && slot.relative?.direction === "cheaper") flags.noCheaper = true;
  }
  // Kept groups are not a successful fetch: with nothing new to show, the turn failed.
  if (succeeded === 0) return t.failed("all_fetches_failed");

  summary.groups = groups.map((g) => ({ label: g.label, status: g.status, match: g.match, total: g.total }));
  summary.flags = flags;

  // The reply. Every fact is decided above; the template states them plainly and is the draft. The model
  // turns it into an answer to what the user wrote; the template is shown if the model fails or quotes a
  // price that is not in the facts (reply/compose.ts).
  const draft = T.resultsText(views, flags, categoryNames);
  // Cards first: everything shown is decided, so the client can show it now; the model only words it.
  t.setPreview({ groups, text: draft });
  t.trace.event("preview", {});
  let written: string | null = null;
  if (writerAdds(views)) {
    t.setStage("writing");
    written = await t.deps.writer.write({ kind: "results", message: text, previous: t.lastExchange, draft, groups: resultFacts(groups, viewOf) }, t.ctx);
  } else {
    t.trace.event("prose_not_needed", { reason: views.length >= 3 ? "list" : "all_missed" });
  }
  summary.reply = written === null ? "template" : "model";
  // A gift or curated set brings its own chips; any other result gets next steps from the screen.
  const chips = suggestions.length > 0 ? suggestions : nextStepSuggestions(groups, { noCheaper: flags.noCheaper });
  summary.memory = nextMemory;
  return t.commit(written ?? draft, { groups, detail: null, ...(chips.length > 0 ? { suggestions: chips } : {}), ...(nextMemory ? { memory: nextMemory } : {}) });
}
