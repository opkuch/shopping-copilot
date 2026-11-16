// "Show more": the next four of each search on screen. A search already shown in full says so and stays.
import type { Group } from "../../messages/schema.ts";
import { CallFailed } from "../ports.ts";
import type { TurnOutcome } from "../ports.ts";
import { withoutMarks } from "../turn.ts";
import type { Turn } from "../turn.ts";

/** Cards one group keeps after "show more" (Group.products max). */
const MAX_SHOWN = 12;

export async function moreTurn(t: Turn, stored: Group[]): Promise<TurnOutcome> {
  const { L } = t;
  t.summary.action = "more";
  t.setStage("searching");
  const lines: string[] = [];
  const groups: Group[] = [];
  let fetched = 0;
  for (const group of stored) {
    const next = group.query.offset + group.products.length;
    if (group.status !== "results" || next >= group.total) {
      groups.push(group);
      if (group.status === "results") lines.push(L.noMore(group.label, group.total));
      continue;
    }
    try {
      const res = await t.deps.retriever.retrieve({ ...group.query, offset: next }, t.ctx);
      fetched++;
      // Appended, like "load more": the earlier cards stay, so "the second one" still points at the same card.
      const products = [...group.products, ...res.products].slice(-MAX_SHOWN);
      groups.push({
        ...withoutMarks(group), query: { ...res.applied, offset: next + res.products.length - products.length }, products, total: res.total,
        status: res.status, match: res.match,
        // The earlier cards are in the message above; this message draws only the new ones.
        shownFrom: products.length - res.products.length,
      });
      lines.push(L.more(group.label, next + 1, next + res.products.length, res.total));
    } catch (err) {
      if (!(err instanceof CallFailed)) throw err;
      groups.push(group);
    }
  }
  if (fetched === 0) return t.commit(lines.join(" ") || L.noMore(stored[0]?.label ?? "", stored[0]?.total ?? 0), null);
  return t.commit(lines.join(" "), { groups, detail: null });
}
