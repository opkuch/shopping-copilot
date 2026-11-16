// The turn policy as a table: router answers + what is on screen -> the action runTurn carries out.
// Each row names the guard it locks. A new override goes here first; if a row is hard to write, the
// override is probably fighting the router rather than complementing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAction } from "../src/pipeline/decide.ts";
import type { DecideInput, TurnAction } from "../src/pipeline/decide.ts";
import type { ProductCard } from "../src/messages/schema.ts";
import { routerResult } from "./fakes/models.ts";

const card = (id: number, title: string, price: number, rating: number): ProductCard => ({
  id, title, price, rating, description: "", thumbnail: "", category: "smartphones", inStock: true,
} as ProductCard);
const ONE = [card(1, "Realme C35", 149.99, 4.1)];
const TWO = [card(1, "Realme C35", 149.99, 4.1), card(2, "iPhone 9", 549, 4.7)];

type Row = {
  name: string;
  input: Partial<DecideInput> & Pick<DecideInput, "router">;
  expect: TurnAction;
};

const product = (act: "new_search" | "refine", over: Partial<Extract<TurnAction, { kind: "product" }>> = {}): TurnAction =>
  ({ kind: "product", act, targetGroup: "unclear", answersPending: false, answersQuestion: false, rejectShown: false, ...over });

const rows: Row[] = [
  // Templates
  { name: "a refusal wins over everything", input: { router: routerResult({ refused: true, act: "new_search" }) }, expect: { kind: "template", reason: "router_refused" } },
  { name: "service, even when the act says search", input: { router: routerResult({ domain: "service" }) }, expect: { kind: "template", reason: "service" } },
  { name: "service before chat ('where is my order?' got a greeting)", input: { router: routerResult({ act: "chat", domain: "service" }) }, expect: { kind: "template", reason: "service" } },
  { name: "chat: catalog overview", input: { router: routerResult({ act: "chat", chatKind: "catalog_overview" }) }, expect: { kind: "template", reason: "catalog_overview" } },
  { name: "chat: something unrelated is off topic, not a greeting", input: { router: routerResult({ act: "chat", chatKind: "other" }) }, expect: { kind: "template", reason: "off_topic" } },
  { name: "chat: greeting", input: { router: routerResult({ act: "chat", chatKind: "greeting" }) }, expect: { kind: "template", reason: "greeting" } },
  { name: "off topic, even when the act says search", input: { router: routerResult({ domain: "off_topic" }) }, expect: { kind: "template", reason: "off_topic" } },

  // The domain question cannot see the cards
  { name: "'tell me about it' said off topic still refers to the one card", input: { router: routerResult({ act: "refer", domain: "off_topic" }), shown: ONE, groupCount: 1 }, expect: { kind: "refer", target: 1 } },
  { name: "'show more' said service is still show more", input: { router: routerResult({ act: "more", domain: "service" }), shown: TWO, groupCount: 1 }, expect: { kind: "more" } },

  // A clarifying question was just asked
  { name: "'for him' after a gift question is an answer, not chat", input: { router: routerResult({ act: "chat", domain: "off_topic" }), hasPurpose: true }, expect: product("new_search", { answersQuestion: true }) },
  { name: "a service request after a gift question is still a service", input: { router: routerResult({ domain: "service" }), hasPurpose: true }, expect: { kind: "template", reason: "service" } },

  // Show more
  { name: "show more by the router", input: { router: routerResult({ act: "more" }), shown: TWO, groupCount: 1 }, expect: { kind: "more" } },
  { name: "show more by the words, router said refine", input: { router: routerResult({ act: "refine" }), text: "תראה עוד", shown: TWO, groupCount: 1 }, expect: { kind: "more" } },
  { name: "show more with nothing on screen is a search (was a failed turn)", input: { router: routerResult({ act: "more" }) }, expect: product("new_search") },

  // Refer
  { name: "refer to a picked card", input: { router: routerResult({ act: "refer", referTarget: 2 }), shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },
  { name: "refer with no cards", input: { router: routerResult({ act: "refer" }) }, expect: { kind: "template", reason: "refer_no_cards" } },
  { name: "refer, unclear among two", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), shown: TWO, groupCount: 1 }, expect: { kind: "template", reason: "refer_unclear" } },
  { name: "refer to a card index the router invented", input: { router: routerResult({ act: "refer", referTarget: 7 }), shown: TWO, groupCount: 1 }, expect: { kind: "template", reason: "refer_unclear" } },
  { name: "'the cheapest one' answers an unclear refer from the prices", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "I want the cheapest one", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 1 } },
  { name: "'the best rated of all 15' with only 4 shown, in another order, sorts the whole search", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "Which one is the highest rated out of all 15?", shown: TWO, groupCount: 1, groups: [{ sort: "relevance", total: 15, shown: 4 }] }, expect: product("refine") },
  { name: "'the cheapest of all' on a list already sorted by price is the shown card", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "I want the cheapest of all", shown: TWO, groupCount: 1, groups: [{ sort: "price_asc", total: 16, shown: 4 }] }, expect: { kind: "refer", target: 1 } },
  { name: "a plain 'I want the cheapest one' picks a shown card even with more matches", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "I want the cheapest one", shown: TWO, groupCount: 1, groups: [{ sort: "rating", total: 16, shown: 4 }] }, expect: { kind: "refer", target: 1 } },
  { name: "'which of all 15 is rated highest?' (word order reversed) sorts the whole search", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "Which of all 15 is rated highest?", shown: TWO, groupCount: 1, groups: [{ sort: "relevance", total: 15, shown: 4 }] }, expect: product("refine") },
  { name: "'הכי מדורג מכולם' in Hebrew sorts the whole search", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "מה הכי מדורג מכולם?", shown: TWO, groupCount: 1, groups: [{ sort: "relevance", total: 9, shown: 4 }] }, expect: product("refine") },
  { name: "a superlative with every match on screen picks among the cards", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "which is the highest rated?", shown: TWO, groupCount: 1, groups: [{ sort: "relevance", total: 2, shown: 2 }] }, expect: { kind: "refer", target: 2 } },
  { name: "'tell me about the Longines' called a new search becomes a refer", input: { router: routerResult({ act: "new_search", referTarget: 2 }), text: "tell me about the iPhone", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },
  { name: "a new search that merely picked a card stays a search", input: { router: routerResult({ act: "new_search", referTarget: 2 }), text: "an iPhone case", shown: TWO, groupCount: 1 }, expect: product("new_search") },

  // Reject: the router decides it; extraction only carries the budget
  { name: "'something else' rejects the cards on screen", input: { router: routerResult({ act: "reject" }), shown: TWO, groupCount: 1 }, expect: product("new_search", { rejectShown: true }) },
  { name: "a rejection said off topic still rejects (the domain cannot see the cards)", input: { router: routerResult({ act: "reject", domain: "off_topic" }), shown: TWO, groupCount: 1 }, expect: product("new_search", { rejectShown: true }) },
  { name: "a rejection with two searches on screen does not ask which", input: { router: routerResult({ act: "reject", targetGroup: "unclear" }), shown: TWO, groupCount: 2 }, expect: product("new_search", { rejectShown: true }) },
  { name: "nothing on screen to reject: a search", input: { router: routerResult({ act: "reject" }) }, expect: product("new_search") },
  { name: "'something else' answering a gift question is the answer", input: { router: routerResult({ act: "reject" }), hasPurpose: true }, expect: product("new_search", { answersQuestion: true }) },

  // Refine and which group
  { name: "refine with nothing on screen is a new search", input: { router: routerResult({ act: "refine" }) }, expect: product("new_search") },
  { name: "refine one search", input: { router: routerResult({ act: "refine" }), shown: TWO, groupCount: 1 }, expect: product("refine") },
  { name: "refine with two searches and no word on which", input: { router: routerResult({ act: "refine", targetGroup: "unclear" }), shown: TWO, groupCount: 2 }, expect: { kind: "which_group" } },
  { name: "refine the second search", input: { router: routerResult({ act: "refine", targetGroup: "second" }), shown: TWO, groupCount: 2 }, expect: product("refine", { targetGroup: "second" }) },
  { name: "'the laptops' answering which-group, router said refer", input: { router: routerResult({ act: "refer", targetGroup: "first" }), shown: TWO, groupCount: 2, hasPending: true }, expect: product("refine", { targetGroup: "first", answersPending: true }) },
  { name: "a pending question with one search on screen is not answered", input: { router: routerResult({ act: "refine", targetGroup: null }), shown: TWO, groupCount: 1, hasPending: true }, expect: product("refine") },
];

for (const row of rows) {
  test(`decide: ${row.name}`, () => {
    const input: DecideInput = { text: "", shown: [], groupCount: 0, hasPurpose: false, hasPending: false, ...row.input };
    assert.deepEqual(decideAction(input).action, row.expect);
  });
}

test("decide: notes record every override for the trace", () => {
  const byName = decideAction({
    router: routerResult({ act: "new_search", referTarget: 2 }), text: "tell me about the iPhone", shown: TWO, groupCount: 1, hasPurpose: false, hasPending: false,
  });
  assert.deepEqual(byName.notes, { referByName: 2 });

  const pending = decideAction({
    router: routerResult({ act: "refer", targetGroup: "both" }), text: "both", shown: TWO, groupCount: 2, hasPurpose: false, hasPending: true,
  });
  assert.deepEqual(pending.notes, { pendingApplied: { targetGroup: "both", routerAct: "refer" }, effectiveAct: "refine" });
});
