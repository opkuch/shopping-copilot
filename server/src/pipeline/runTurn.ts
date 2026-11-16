// The orchestrator: one turn, start to finish. Plain code on purpose: every branch is a line a test points at.
// It reads the conversation, runs the router and extraction together, lets decide.ts pick the action, and
// hands it to actions/ (search, more, refer) or ends with a fixed template.
import type { ConversationMemory, Group, Preview, ProductCard, RouterResult, Stage } from "../messages/schema.ts";
import { VERSION as EXTRACT_VERSION } from "../prompts/extract.ts";
import { VERSION as PROSE_VERSION } from "../prompts/prose.ts";
import { VERSION as ROUTER_VERSION } from "../prompts/router.ts";
import { templatesFor } from "../reply/templates.ts";
import { detectLanguage } from "../reply/language.ts";
import { createBudget } from "./budget.ts";
import { createLocks } from "./locks.ts";
import { decideAction } from "./decide.ts";
import type { CategoryInfo, RouterInput, ShownCard, TraceSink, TurnOutcome, TurnRunner } from "./ports.ts";
import { createEndings, settle } from "./turn.ts";
import type { Turn, TurnDeps } from "./turn.ts";
import { moreTurn } from "./actions/more.ts";
import { referTurn } from "./actions/refer.ts";
import { appliesToBoth, askWhichGroup, searchTurn } from "./actions/search.ts";

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
  const language = detectLanguage(userMessage.text);
  const summary: Record<string, unknown> = {
    promptVersions: { router: ROUTER_VERSION, extraction: EXTRACT_VERSION, prose: PROSE_VERSION },
    utterance: userMessage.text,
    language,
  };
  const snapshot = (outcome: string) => ({ ...summary, outcome, totalMs: Math.round(clock() - started), events });

  let attempt = 1;
  const extractAbort = new AbortController();
  const endings = createEndings({ ...args, store, language, summary, snapshot, attempt: () => attempt, extractAbort });

  let namesP: Promise<CategoryInfo[] | null> | null = null;
  const t: Turn = {
    deps, ctx, trace, summary, text: userMessage.text, language, L: templatesFor(language), setStage, setPreview,
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
    // Longer than one exchange: the purpose of the conversation and what was rejected. A clarifying
    // question's own purpose counts as the memory's purpose too.
    const memory: ConversationMemory | null = previous?.memory ?? (previous?.purpose ? { purpose: previous.purpose, excluded: [] } : null);
    t.memory = memory;
    const input: RouterInput = {
      utterance: userMessage.text,
      storedQueries: stored.map((g) => ({ label: g.label, query: g.query })),
      shownCards,
      previous: t.lastExchange,
      memory,
    };
    const pending = previous?.pending ?? null;
    // The last reply asked a clarifying question ("a gift: for whom, what budget?"); this message answers it.
    const purposeCtx = previous?.purpose ?? null;

    // 2. Router and extraction start together; the router decides whether extraction is needed.
    setStage("classifying");
    const routed = settle(() => deps.router.route(input, ctx));
    const extracted = settle(() => deps.slots.extract(input, { ...ctx, signal: extractAbort.signal }));

    const routerOut = await routed;
    if (!routerOut.ok) {
      extractAbort.abort();
      return t.failed("router_failed", routerOut.error);
    }
    const r: RouterResult = routerOut.value;
    summary.router = { act: r.act, domain: r.domain, refused: r.refused, answers: r.answers };

    // 3. The router proposes; the policy in decide.ts decides.
    const { action, notes } = decideAction({
      router: r, text: userMessage.text, shown: shownProducts, groupCount: stored.length,
      hasPurpose: purposeCtx !== null, hasPending: pending !== null,
      groups: stored.map((g) => ({ sort: g.query.sort, total: g.total, shown: g.products.length })),
    });
    if (notes.purposeApplied) summary.purposeApplied = purposeCtx;
    if (notes.referByName !== undefined) summary.referByName = notes.referByName;
    if (notes.pendingApplied) summary.pendingApplied = notes.pendingApplied;
    if (notes.effectiveAct) summary.effectiveAct = notes.effectiveAct;

    // 4. Carry it out.
    const { L } = t;
    switch (action.kind) {
      case "template":
        switch (action.reason) {
          case "router_refused": return t.template("router_refused", L.refusal());
          case "service": return t.template("service", L.service());
          case "catalog_overview": return t.template("catalog_overview", L.catalogOverview(await t.loadNames()));
          case "off_topic": return t.template("off_topic", L.offTopic());
          case "greeting": return t.template("greeting", L.greeting());
          case "refer_no_cards": return t.template("refer_no_cards", L.referNoCards());
          case "refer_unclear": return t.template("refer_unclear", L.referUnclear(shownCards.length));
        }
        break;
      case "more":
        extractAbort.abort();
        return await moreTurn(t, stored);
      case "refer":
        extractAbort.abort();
        return await referTurn(t, shownProducts[action.target - 1] as ProductCard);
      case "which_group": {
        // "And something under $30?" with two searches on screen: a price or stock limit with no product
        // named reads as both; only a relative change ("cheaper") or a product-specific one asks which.
        const [g1, g2] = stored as [Group, Group];
        if (!(await appliesToBoth(extracted))) return await askWhichGroup(t, g1, g2, extracted);
        summary.targetInferred = "both";
        return await searchTurn(t, r, "refine", stored, "both", extracted, null, null, false);
      }
      case "product":
        return await searchTurn(t, r, action.act, stored, action.targetGroup, extracted,
          action.answersPending ? pending : null, action.answersQuestion ? purposeCtx : null, action.rejectShown);
    }
    return t.failed("unexpected", new Error(`unhandled action ${JSON.stringify(action)}`));
  } catch (err) {
    return t.failed("unexpected", err);
  }
}
