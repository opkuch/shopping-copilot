// A product search: new, refined, or a rejection of what is shown. Turns the extraction into at most two
// queries, fetches them in parallel, shows the cards as soon as they are decided, then has the reply written.
import type {
  ConversationMemory, ExtractedIntent, ExtractionResult, Group, Payload, PurposeContext, Query, RouterResult, Suggestion,
} from "../../messages/schema.ts";
import type * as T from "../../reply/templates.ts";
import { droppedAttributes } from "../../reply/templates.ts";
import { intentToQuery, labelFor, patchQuery, scopePrices } from "../merge.ts";
import { CallFailed } from "../ports.ts";
import type { ResultFacts, RetrievalQuery, Retriever, TurnFlags, TurnOutcome } from "../ports.ts";
import { rejectsByWords } from "../decide.ts";
import { clarifySuggestions, giftCategories, narrowSuggestions, nextStepSuggestions, planPurpose, rejectionBrowse } from "../purpose.ts";
import { EMPTY_INTENT, asRepeat, describe, isEmptyIntent } from "../turn.ts";
import type { Settled, Turn } from "../turn.ts";

type Relative = { direction: "cheaper" | "pricier"; price: number };
type Slot =
  | { kind: "fetch"; requested: RetrievalQuery; relative: Relative | null; from: Group | null; genderInherited?: boolean }
  | { kind: "keep"; group: Group };

/** A limit that fits every search: a price bound or stock wish, nothing product-specific, nothing relative. */
export async function appliesToBoth(extracted: Promise<Settled<ExtractionResult>>): Promise<boolean> {
  const ex = await extracted;
  if (!ex.ok || ex.value.refused) return false;
  const intents = ex.value.extraction.intents;
  if (intents.length !== 1) return false;
  const i = intents[0] as ExtractedIntent;
  const limitOnly = i.priceMin !== null || i.priceMax !== null || i.inStock === true;
  return limitOnly && i.category === null && i.noun === null && (i.attributes ?? []).length === 0 && i.relativePrice === null;
}

/**
 * "Make it cheaper" with two searches on screen: ask which. The question waits for extraction so the change
 * it asks about is stored with it and applied when the next message names a group.
 */
export async function askWhichGroup(t: Turn, g1: Group, g2: Group, extracted: Promise<Settled<ExtractionResult>>): Promise<TurnOutcome> {
  t.summary.template = "ask_which_group";
  const ex = await extracted;
  const intents = ex.ok && !ex.value.refused ? ex.value.extraction.intents.filter((i) => !isEmptyIntent(i)) : [];
  t.summary.pendingStored = intents.length;
  const payload: Payload | null = intents.length > 0 ? { groups: [], detail: null, pending: intents } : null;
  return t.commit(t.L.askWhichGroup(g1.label, g2.label), payload);
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
    const droppedWords =
      fetched.match === "attributes_relaxed" ? droppedAttributes(requested, fetched.query)
      : fetched.match === "category_fallback" ? [...(requested.noun === null ? [] : [requested.noun]), ...requested.attributes]
      : [];
    return {
      label: group.label,
      outcome: fetched.status === "results" ? "results" : fetched.status === "miss" ? "no_match" : "could_not_load",
      match: fetched.match,
      droppedWords,
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

export async function searchTurn(
  t: Turn, r: RouterResult, act: "new_search" | "refine", stored: Group[],
  targetGroup: "first" | "second" | "both" | "unclear", extracted: Promise<Settled<ExtractionResult>>,
  pendingIntents: ExtractedIntent[] | null,
  purposeCtx: PurposeContext | null,
  rejectShown: boolean,
): Promise<TurnOutcome> {
  const { summary, L, language, memory, text } = t;
  const ex = await extracted;
  if (!ex.ok) return t.failed("extraction_failed", ex.error);
  if (ex.value.refused) return t.template("extraction_refused", L.refusal());
  const extraction = ex.value.extraction;
  summary.extraction = extraction;

  // At most two intents, whatever the extractor sent. "The laptops" after "Which one should I change?" says
  // which group, not what to change: the change is the one stored with the question, unless this message states one.
  const own = extraction.intents.slice(0, 2);
  const intents = pendingIntents !== null && own.every(isEmptyIntent) ? pendingIntents : own;
  const flags: TurnFlags = {
    droppedIntents: extraction.droppedIntentCount > 0,
    mentionsService: r.mentionsService,
    currencyNotApplied: false,
    currencyConverted: false,
    secondPatchIgnored: false,
    noCheaper: null,
    noPricier: null,
  };

  const names = t.loadNames(); // starts now, overlaps with the catalog fetches
  const slots: Slot[] = [];
  let suggestions: Suggestion[] = [];
  let nextMemory: ConversationMemory | null = memory;
  // "Something else", "not earrings": what is on screen is rejected. Back to the conversation's purpose
  // (a gift for her) without the rejected kinds. The router's `reject` act decides it; the words are a
  // backup when the router said refine or search and extraction named no product.
  const byWords = !rejectShown && intents.length === 1 && stored.length > 0 && rejectsByWords(intents[0] as ExtractedIntent, text);
  const rejecting = (rejectShown && stored.length > 0) || byWords;
  if (rejecting) {
    summary.rejectedBy = byWords ? "words" : "router";
    const intent = intents[0] ?? EMPTY_INTENT;
    const shownCategories = [...new Set(stored.flatMap((g) => g.products.map((p) => p.category)))] as Query["category"][];
    const rejected = shownCategories.filter((c): c is NonNullable<Query["category"]> => c !== null);
    const base = memory ?? { purpose: null, excluded: [] };
    const made = intentToQuery({ ...intent, noun: null, category: null, attributes: null }, text);
    // The price follows the same rule as a refine: "not jewelry" after "under $100" is still under $100,
    // while "something else, more expensive" replaces the range.
    const first = stored[0] as Group;
    const price = patchQuery(first.query, { ...EMPTY_INTENT, priceMin: intent.priceMin, priceMax: intent.priceMax, currency: intent.currency, relativePrice: intent.relativePrice, clear: intent.clear.filter((f) => f === "price") }, text, first.products).query;
    const plan = rejectionBrowse(base, rejected, first.query.gender, price.priceMax, price.priceMin);
    summary.rejected = { rejected, within: plan.within };
    nextMemory = { purpose: base.purpose, excluded: plan.excluded };
    const query: Query = { ...made.query, gender: plan.gender, within: plan.within, purpose: plan.purpose, priceMin: plan.priceMin, priceMax: plan.priceMax };
    slots.push({ kind: "fetch", requested: query, relative: null, from: null });
    suggestions = narrowSuggestions(language);
  } else if (act === "new_search") {
    const list = intents.length > 0 ? scopePrices(intents, text) : [EMPTY_INTENT];
    if (list !== intents && intents.length > 0) summary.priceScoped = true;
    for (const intent of list) {
      const made = intentToQuery(intent, text);
      flags.currencyNotApplied ||= made.currencyNotApplied;
      flags.currencyConverted ||= made.currencyConverted;
      let query = made.query;
      // What the question already knew: "a gift for dad" then "perfume" is a men's perfume.
      const genderInherited = purposeCtx !== null && query.gender === null && purposeCtx.gender !== null;
      if (genderInherited) query = { ...query, gender: purposeCtx.gender };
      const plan = planPurpose(intent, query, purposeCtx);
      // A new product or category with no gift words is a new topic: the purpose and the rejections end.
      if (plan === null && (intent.category !== null || intent.noun !== null) && intent.gift !== true && purposeCtx === null) {
        nextMemory = null;
      }
      if (plan?.kind === "clarify" && list.length === 1) {
        summary.action = "clarify";
        summary.clarify = plan;
        t.extractAbort.abort();
        return t.commit(L.clarify(plan.why, plan.context), {
          groups: [], detail: null, suggestions: clarifySuggestions(plan.context, language), purpose: plan.context,
          memory: { purpose: plan.context, excluded: [] },
        });
      }
      if (plan?.kind === "browse") {
        summary.purposePlan = plan;
        query = { ...query, attributes: [], within: plan.within, purpose: plan.purpose, gender: plan.gender, priceMin: plan.priceMin, priceMax: plan.priceMax };
        // Gift chips: a budget when none was given (asking once means it may still be missing), then kinds of product.
        const noBudget = plan.priceMin === null && plan.priceMax === null;
        const ctxNow: PurposeContext = { gift: noBudget, gender: plan.gender, kid: false, theme: null };
        suggestions = plan.purpose === "gift" ? clarifySuggestions(ctxNow, language) : narrowSuggestions(language);
        if (plan.purpose === "gift") nextMemory = { purpose: { gift: true, gender: plan.gender, kid: false, theme: plan.theme ?? purposeCtx?.theme ?? null }, excluded: memory?.excluded ?? [] };
      }
      slots.push({ kind: "fetch", requested: query, relative: null, from: null, genderInherited });
    }
  } else {
    const both = stored.length === 2 && targetGroup === "both";
    const differ = intents.length === 2 && JSON.stringify(intents[0]) !== JSON.stringify(intents[1]);
    // "Laptops under 1000 and the perfume under 30": two different patches for two groups go one to each,
    // in order. The model repeats one patch per group for "make both cheaper", which is the same change
    // twice. Only a different second patch for a single group is ignored.
    const perGroup = both && differ;
    flags.secondPatchIgnored = differ && !perGroup;
    const targets = stored.length === 1 || both ? [0, 1] : targetGroup === "first" ? [0] : [1];
    stored.forEach((group, i) => {
      if (!targets.includes(i)) return void slots.push({ kind: "keep", group });
      const intent = (perGroup ? intents[i] : intents[0]) ?? EMPTY_INTENT;
      const patched = patchQuery(group.query, intent, text, group.products);
      flags.currencyNotApplied ||= patched.currencyNotApplied;
      flags.currencyConverted ||= patched.currencyConverted;
      const relative: Relative | null =
        patched.cheaperThan !== null ? { direction: "cheaper", price: patched.cheaperThan }
        : patched.pricierThan !== null ? { direction: "pricier", price: patched.pricierThan }
        : null;
      let query = patched.query;
      // A gift's categories come from whom it is for, so they are rebuilt from the memory on every change:
      // "for my mom" after "for my dad" gets her gift set, not his set under a women's filter.
      const purpose = memory?.purpose ?? null;
      if (query.purpose === "gift" && purpose?.gift) {
        const now = { ...purpose, gender: query.gender };
        const excluded = memory?.excluded ?? [];
        query = { ...query, within: giftCategories(now).filter((c) => !excluded.includes(c)) };
        nextMemory = { purpose: now, excluded };
      }
      slots.push({ kind: "fetch", requested: query, relative, from: group });
    });
  }
  summary.queries = slots.map((s) => (s.kind === "fetch"
    ? { fetched: true, query: s.requested, categoryStated: s.requested.categoryStated, relative: s.relative }
    : { fetched: false }));

  // All fetches at once; one failure must not discard the other group.
  t.setStage("searching");
  const fetches = slots.filter((s): s is Extract<Slot, { kind: "fetch" }> => s.kind === "fetch");
  const settled = await Promise.allSettled(
    fetches.map((s) => t.deps.retriever.retrieve(s.requested, t.ctx, { mayDropNoun: s.relative === null, exactOnly: s.relative !== null, genderInherited: s.genderInherited })),
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
        label: labelFor(res.applied, categoryNames, language), status: res.status, match: res.match,
        query: res.applied, products: res.products, total: res.total,
      };
    } else if (outcome.reason instanceof CallFailed) {
      const query = slot.requested;
      t.trace.event("group_unavailable", { query, ...describe(outcome.reason) });
      group = { label: labelFor(query, categoryNames, language), status: "unavailable", match: "none", query, products: [], total: 0 };
    } else {
      throw outcome.reason;
    }
    const requested = slot.requested;
    // A refine that finds nothing (or cannot load) keeps the cards on screen: the impossible query must not
    // become the working query, or "the second one" would point at nothing. Only when nothing in this turn
    // found anything: old cards must not stay under a sentence that says there are none.
    const previous = slot.from;
    const keepPrevious = group.status !== "results" && previous !== null && previous.products.length > 0 && !anyNewResults;
    if (keepPrevious) t.trace.event("refine_kept_previous", { status: group.status, relative: slot.relative, label: previous.label });
    const view: T.GroupView = { group, requested, relative: slot.relative, keptPrevious: keepPrevious };
    // The kept cards are already on screen in the message above: marked, so they are not drawn twice.
    groups.push(keepPrevious ? asRepeat(previous) : group);
    views.push(view);
    viewOf.push(view);
    if (group.status === "miss" && slot.relative?.direction === "cheaper") flags.noCheaper ??= { price: slot.relative.price };
    if (group.status === "miss" && slot.relative?.direction === "pricier") flags.noPricier ??= { price: slot.relative.price };
  }
  // Kept groups are not a successful fetch: with nothing new to show, the turn failed.
  if (succeeded === 0) return t.failed("all_fetches_failed");

  summary.groups = groups.map((g) => ({ label: g.label, status: g.status, match: g.match, total: g.total }));
  summary.fallbackPath = groups.filter((g) => g.match !== "exact" && g.match !== "none").map((g) => g.match);
  summary.flags = flags;

  // The reply. Every fact is decided above; the template states them plainly and is the draft. The model
  // turns it into an answer to what the user wrote; the template is shown if the model fails or quotes a
  // price that is not in the facts (reply/compose.ts).
  const draft = L.resultsText(views, flags, categoryNames);
  // Cards first: everything shown is decided, so the client can show it now; the model only words it.
  t.setPreview({ groups, text: draft });
  t.trace.event("preview", {});
  t.setStage("writing");
  const written = await t.deps.writer.write({
    kind: "results", language, message: text, previous: t.lastExchange, draft,
    groups: resultFacts(groups, viewOf),
  }, t.ctx);
  summary.reply = written === null ? "template" : "model";
  // A gift or curated set brings its own chips; any other result gets next steps from the screen.
  const chips = suggestions.length > 0 ? suggestions : nextStepSuggestions(groups, language, { noCheaper: flags.noCheaper !== null });
  summary.memory = nextMemory;
  return t.commit(written ?? draft, { groups, detail: null, ...(chips.length > 0 ? { suggestions: chips } : {}), ...(nextMemory ? { memory: nextMemory } : {}) });
}
