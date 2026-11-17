// The orchestrator: one turn, start to finish. Plain code on purpose: every branch is a line a test points at.
// It reads the conversation, runs the router and extraction together, lets decide.ts pick the action, and
// hands it to actions/ (search, more, remove, refer, answer) or ends with a fixed template.
import type { ConversationMemory, ExtractionResult, Group, Preview, ProductCard, RouterResult, Stage } from "../messages/schema.ts";
import { VERSION as EXTRACT_VERSION } from "../prompts/extract.ts";
import { VERSION as PROSE_VERSION } from "../prompts/prose.ts";
import { VERSION as ROUTER_VERSION } from "../prompts/router.ts";
import * as T from "../reply/templates.ts";
import { createBudget } from "./budget.ts";
import { createLocks } from "./locks.ts";
import { MORE_RE, decideAction, namedPosition } from "./decide.ts";
import type { RouterInput, ShownCard, TraceSink, TurnOutcome, TurnRunner } from "./ports.ts";
import { nextStepSuggestions, starterSuggestions } from "./purpose.ts";
import { createEndings, describe, settle } from "./turn.ts";
import type { Settled, Turn, TurnDeps } from "./turn.ts";
import { moreTurn, removeTurn } from "./actions/more.ts";
import { answerTurn, referTurn } from "./actions/refer.ts";
import { appliesToAll, askWhichGroup, searchTurn } from "./actions/search.ts";

export type { TurnDeps } from "./turn.ts";

type TurnArgs = Parameters<TurnRunner["run"]>[0];

export function createTurnRunner(deps: TurnDeps): TurnRunner {
  const locks = createLocks();
  return {
    run: (args) => locks.run(args.userMessage.id, (setStage, setPreview) => runOnce(deps, args, setStage, setPreview)),
    stage: (id) => locks.stage(id),
    preview: (id) => locks.preview(id),
  };
}

async function runOnce(
  deps: TurnDeps, args: TurnArgs, setStage: (stage: Stage) => void, setPreview: (preview: Preview) => void = () => {},
): Promise<TurnOutcome> {
  const { store } = deps;
  const { conversationId, userMessage } = args;
  const clock = deps.now ?? (() => performance.now());
  const started = clock();
  const budget = createBudget(deps.turnMs ?? 25_000, clock);

  const events: Array<{ kind: string; atMs: number; data: Record<string, unknown> }> = [];
  const trace: TraceSink = {
    event: (kind, data) => void events.push({ kind, atMs: Math.round(clock() - started), data }),
  };
  const ctx = { budget, trace };
  const summary: Record<string, unknown> = {
    promptVersions: { router: ROUTER_VERSION, extraction: EXTRACT_VERSION, prose: PROSE_VERSION },
    utterance: userMessage.text,
  };
  const snapshot = (outcome: string) => ({ ...summary, outcome, totalMs: Math.round(clock() - started), events });

  let attempt = 1;
  let memory: ConversationMemory | null = null;
  const extractAbort = new AbortController();
  const endings = createEndings({ ...args, store, summary, snapshot, attempt: () => attempt, memory: () => memory, extractAbort });

  let namesP: ReturnType<Turn["loadNames"]> | null = null;
  const t: Turn = {
    deps, ctx, trace, summary, text: userMessage.text, setStage, setPreview,
    extractAbort, lastExchange: null, memory: null, ...endings,
    loadNames: () => (namesP ??= settle(() => deps.categories.names(ctx)).then((r) => (r.ok ? r.value : null))),
  };

  try {
    attempt = store.nextAttempt(userMessage.id);

    // 1. What is on screen: the stored searches and their cards, flattened in display order.
    const working = store.workingQuery(conversationId);
    const stored: Group[] = working?.groups ?? [];
    const shownProducts = stored.flatMap((g) => g.products);
    const shownCards: ShownCard[] = shownProducts.map((p, i) => ({
      index: i + 1, id: p.id, title: p.title, category: p.category, price: p.price,
    }));
    const previous = store.previousExchange(conversationId);
    t.lastExchange = previous === null ? null : { user: previous.user, assistant: previous.assistant };
    // Longer than one exchange: the purpose of the conversation and what was rejected.
    memory = t.memory = previous?.memory ?? null;
    // The last reply asked "Which one should I change?"; this message may answer it.
    const pending = previous?.pending ?? null;
    const input: RouterInput = {
      utterance: userMessage.text,
      storedQueries: stored.map((g) => ({ label: g.label, query: g.query })),
      shownCards,
      previous: t.lastExchange,
      memory,
    };

    // A click on a card names its product: when the chat has shown it, in any reply, its details open with no
    // model call to work out which card was meant. Otherwise the message is read like any other.
    const clicked = args.productId === undefined ? null : store.shownCard(conversationId, args.productId);
    if (clicked !== null) {
      summary.cardClick = clicked.id;
      return await referTurn(t, clicked);
    }

    // 2. Router and extraction start together; the router decides whether extraction is needed.
    setStage("classifying");
    const routed = settle(() => deps.router.route(input, ctx));
    const extracted = settle(() => deps.slots.extract(input, { ...ctx, signal: extractAbort.signal }));

    const routerOut = await routed;
    let r: RouterResult;
    if (routerOut.ok) {
      r = routerOut.value;
    } else {
      // The router is the cheap call; when it fails, what code can read without it still works: "show more"
      // and "the second one" said in so many words, and a message the extractor reads as naming a product.
      // Anything else (a question about a card, chat) needs the router, so it fails.
      const fallback = routeByWords(userMessage.text, shownProducts.length, stored.length) ?? await searchWithoutRouter(extracted);
      if (fallback === null) {
        extractAbort.abort();
        return t.failed("router_failed", routerOut.error);
      }
      summary.routerFallback = describe(routerOut.error);
      r = fallback;
    }
    summary.router = { act: r.act, domain: r.domain, refused: r.refused, answers: r.answers };

    // 3. The router proposes; the policy in decide.ts decides.
    const { action, notes } = decideAction({ router: r, text: userMessage.text, shown: shownProducts, groupCount: stored.length, pending: pending?.op ?? null });
    if (notes.referByName !== undefined) summary.referByName = notes.referByName;
    if (notes.effectiveAct) summary.effectiveAct = notes.effectiveAct;
    if (notes.pendingApplied !== undefined) summary.pendingApplied = notes.pendingApplied;
    const searchOpts = { mentionsService: r.mentionsService, pending };

    // 4. Carry it out.
    switch (action.kind) {
      case "template": {
        // A reply that cannot help still offers a next step: example searches, or what fits the cards on screen.
        const onScreen = nextStepSuggestions(stored);
        switch (action.reason) {
          case "router_refused": return t.template("router_refused", T.refusal());
          case "service": return t.template("service", T.service(), starterSuggestions());
          case "catalog_overview": return t.template("catalog_overview", T.catalogOverview(await t.loadNames()));
          case "off_topic": return t.template("off_topic", T.offTopic(), starterSuggestions());
          case "greeting": return t.template("greeting", T.greeting(), onScreen);
          case "refer_no_cards": return t.template("refer_no_cards", T.referNoCards());
          case "refer_unclear": return t.template("refer_unclear", T.referUnclear(shownCards.length));
          case "remove_only": return t.template("remove_only", T.removeOnly(), onScreen);
        }
        break;
      }
      case "more":
        extractAbort.abort();
        return await moreTurn(t, stored, action.target);
      case "remove":
        return removeTurn(t, stored, action.target);
      case "which_group":
        // "Anything under $30?" with a list on screen: a limit with no product named fits every search, so it is
        // applied to all and the reply says so. Anything else asks once which search is meant.
        if (action.op === "refine" && (await appliesToAll(extracted))) {
          summary.targetInferred = "all";
          return await searchTurn(t, { kind: "product", act: "refine", targetGroup: "all", rejectShown: false, answersPending: false }, stored, extracted, { ...searchOpts, appliedToAll: true });
        }
        return await askWhichGroup(t, stored, action.op, extracted);
      case "refer":
        extractAbort.abort();
        return await referTurn(t, shownProducts[action.target - 1] as ProductCard);
      case "answer":
        extractAbort.abort();
        return await answerTurn(t, shownProducts);
      case "product":
        return await searchTurn(t, action, stored, extracted, searchOpts);
    }
    return t.failed("unexpected", new Error(`unhandled action ${JSON.stringify(action)}`));
  } catch (err) {
    return t.failed("unexpected", err);
  }
}

/** "Show more" or "the second one" in so many words, with cards on screen: the act the router would have said. */
export function routeByWords(text: string, shown: number, groups: number): RouterResult | null {
  const base = { refused: false, domain: "catalog", chatKind: "other", mentionsService: false, targetGroup: null, referTarget: null, answers: {} } as const;
  if (groups > 0 && MORE_RE.test(text.trim())) return { ...base, act: "more" };
  const position = namedPosition(text);
  if (position !== null && position >= 1 && position <= shown) return { ...base, act: "refer", referTarget: position };
  return null;
}

/** A new search the router would have said, when extraction names a product; otherwise null. */
async function searchWithoutRouter(extracted: Promise<Settled<ExtractionResult>>): Promise<RouterResult | null> {
  const out = await extracted;
  if (!out.ok || out.value.refused) return null;
  const named = out.value.extraction.intents.some((i) => i.noun !== null || i.category !== null);
  if (!named) return null;
  return {
    refused: false, act: "new_search", domain: "catalog", chatKind: "other", mentionsService: false,
    targetGroup: null, referTarget: null, answers: {},
  };
}
