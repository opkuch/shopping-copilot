// Changes to the searches on screen that need no new query: "show more" (the next cards of one search, or of
// each), and "remove the eggs" (one item off a list).
import type { Group } from "../../messages/schema.ts";
import * as T from "../../reply/templates.ts";
import type { Target } from "../decide.ts";
import { CallFailed } from "../ports.ts";
import type { TurnOutcome } from "../ports.ts";
import { asRepeat, cardsPerGroup, withoutMarks } from "../turn.ts";
import type { Turn } from "../turn.ts";

/** Cards one group keeps after "show more" (Group.products max). */
const MAX_SHOWN = 12;

type Paged = { group: Group; line: string | null; fetched: boolean };

async function nextPage(t: Turn, group: Group, pageSize: number): Promise<Paged> {
  const next = group.query.offset + group.products.length;
  if (group.status !== "results" || next >= group.total) {
    return { group: asRepeat(group), line: group.status === "results" ? T.noMore(group.label, group.total) : null, fetched: false };
  }
  if (group.products.length >= MAX_SHOWN) {
    return { group: asRepeat(group), line: `That's as many ${group.label} as I can show at once; a budget or a detail narrows them down.`, fetched: false };
  }
  try {
    const res = await t.deps.retriever.retrieve({ ...group.query, offset: next }, t.ctx, { pageSize });
    // Appended, like "load more": the earlier cards stay, so "the second one" still points at the same card.
    const products = [...group.products, ...res.products].slice(0, MAX_SHOWN);
    const added = products.length - group.products.length;
    return {
      group: {
        ...withoutMarks(group), query: { ...res.applied, offset: group.query.offset }, products, total: res.total,
        status: res.status, match: res.match,
        // The earlier cards are in the message above; this message draws only the new ones.
        shownFrom: group.products.length,
      },
      line: T.more(group.label, next + 1, next + added, res.total),
      fetched: true,
    };
  } catch (err) {
    if (!(err instanceof CallFailed)) throw err;
    return { group: asRepeat(group), line: `I couldn't load more ${group.label} right now.`, fetched: false };
  }
}

/** The next cards of the search named ("swap #2"), or of every search on screen. The others stay as they are. */
export async function moreTurn(t: Turn, stored: Group[], target: Target): Promise<TurnOutcome> {
  t.summary.action = "more";
  t.setStage("searching");
  const pageSize = cardsPerGroup(stored.length);
  const pages = await Promise.all(stored.map((g, i) => (target === "all" || target === i + 1
    ? nextPage(t, g, pageSize)
    : Promise.resolve<Paged>({ group: asRepeat(g), line: null, fetched: false }))));
  const text = pages.map((p) => p.line).filter((l): l is string => l !== null).join(" ");
  if (!pages.some((p) => p.fetched)) return t.commit(text || T.noMore(stored[0]?.label ?? "", stored[0]?.total ?? 0), null);
  return t.commit(text, { groups: pages.map((p) => p.group), detail: null, ...(t.memory ? { memory: t.memory } : {}) });
}

/** One item off a list: the other searches stay on screen unchanged and remain the working list. */
export function removeTurn(t: Turn, stored: Group[], target: number): TurnOutcome {
  t.summary.action = "remove";
  t.extractAbort.abort();
  const gone = stored[target - 1] as Group;
  const left = stored.filter((_, i) => i !== target - 1);
  t.summary.removed = gone.label;
  return t.commit(T.removed(gone.label, left.map((g) => g.label)), {
    groups: left.map(asRepeat), detail: null, ...(t.memory ? { memory: t.memory } : {}),
  });
}
