// The turn policy as a table: router answers + what is on screen -> the action runTurn carries out.
// Each row names the guard it locks. A new override goes here first; if a row is hard to write, the
// override is probably fighting the router rather than complementing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MORE_RE, decideAction, namedPosition } from "../src/pipeline/decide.ts";
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
  ({ kind: "product", act, targetGroup: "all", rejectShown: false, answersPending: false, ...over });

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
  { name: "'show more' said service is still show more", input: { router: routerResult({ act: "more", domain: "service" }), shown: TWO, groupCount: 1 }, expect: { kind: "more", target: "all" } },

  // Show more
  { name: "show more by the router", input: { router: routerResult({ act: "more" }), shown: TWO, groupCount: 1 }, expect: { kind: "more", target: "all" } },
  { name: "show more by the words, router said refine", input: { router: routerResult({ act: "refine" }), text: "show me more", shown: TWO, groupCount: 1 }, expect: { kind: "more", target: "all" } },
  { name: "'swap #2' on a list is more of that one search", input: { router: routerResult({ act: "more", targetGroup: 2 }), text: "swap #2", shown: TWO, groupCount: 4 }, expect: { kind: "more", target: 2 } },
  { name: "'show me more expensive' is the router's refine, not the next page", input: { router: routerResult({ act: "refine" }), text: "show me more expensive", shown: TWO, groupCount: 1 }, expect: product("refine") },
  { name: "'show more red' is the router's refine, not the next page", input: { router: routerResult({ act: "refine" }), text: "show more red", shown: TWO, groupCount: 1 }, expect: product("refine") },
  { name: "show more with nothing on screen is a search (was a failed turn)", input: { router: routerResult({ act: "more" }) }, expect: product("new_search") },

  // One shown card
  { name: "refer to a picked card", input: { router: routerResult({ act: "refer", referTarget: 2 }), shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },
  { name: "refer with no cards", input: { router: routerResult({ act: "refer" }) }, expect: { kind: "template", reason: "refer_no_cards" } },
  { name: "'the cheapest one' answers an unclear refer from the prices", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "I want the cheapest one", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 1 } },
  { name: "'which is the highest rated?' picks among the cards", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "which is the highest rated?", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },
  { name: "'tell me about the Longines' called a new search becomes a refer", input: { router: routerResult({ act: "new_search", referTarget: 2 }), text: "tell me about the iPhone", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },
  { name: "a new search that merely picked a card stays a search", input: { router: routerResult({ act: "new_search", referTarget: 2 }), text: "an iPhone case", shown: TWO, groupCount: 1 }, expect: product("new_search") },
  { name: "'the second one' with one card on screen says so, never describes the first", input: { router: routerResult({ act: "refer", referTarget: 1 }), text: "tell me about the second one", shown: ONE, groupCount: 1 }, expect: { kind: "template", reason: "refer_unclear" } },
  { name: "'the second one' with two cards on screen is the second", input: { router: routerResult({ act: "refer", referTarget: 2 }), text: "tell me about the second one", shown: TWO, groupCount: 1 }, expect: { kind: "refer", target: 2 } },

  // A question about the shown cards that names no single one is answered from their details
  { name: "'compare them' is answered, not 'Which one?'", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "compare them", shown: TWO, groupCount: 1 }, expect: { kind: "answer" } },
  { name: "'which is best for running?' is answered from the listings", input: { router: routerResult({ act: "refer", referTarget: "unclear" }), text: "which of these is best for running?", shown: TWO, groupCount: 1 }, expect: { kind: "answer" } },
  { name: "a card index the router invented is answered over the shown cards", input: { router: routerResult({ act: "refer", referTarget: 7 }), shown: TWO, groupCount: 1 }, expect: { kind: "answer" } },

  // Reject: the router decides it; extraction only carries the budget
  { name: "'something else' rejects the cards on screen", input: { router: routerResult({ act: "reject" }), shown: TWO, groupCount: 1 }, expect: product("new_search", { rejectShown: true }) },
  { name: "a rejection said off topic still rejects (the domain cannot see the cards)", input: { router: routerResult({ act: "reject", domain: "off_topic" }), shown: TWO, groupCount: 1 }, expect: product("new_search", { rejectShown: true }) },
  { name: "nothing on screen to reject: a search", input: { router: routerResult({ act: "reject" }) }, expect: product("new_search") },

  // Refine, and which of two searches
  { name: "refine with nothing on screen is a new search", input: { router: routerResult({ act: "refine" }) }, expect: product("new_search") },
  { name: "refine one search", input: { router: routerResult({ act: "refine" }), shown: TWO, groupCount: 1 }, expect: product("refine") },
  { name: "refine the second search", input: { router: routerResult({ act: "refine", targetGroup: 2 }), shown: TWO, groupCount: 2 }, expect: product("refine", { targetGroup: 2 }) },
  { name: "'a cheaper sunscreen' on a five-item list changes only that search", input: { router: routerResult({ act: "refine", targetGroup: 3 }), shown: TWO, groupCount: 5 }, expect: product("refine", { targetGroup: 3 }) },
  { name: "several searches and no word on which: ask once", input: { router: routerResult({ act: "refine", targetGroup: "unclear" }), shown: TWO, groupCount: 2 }, expect: { kind: "which_group", op: "refine" } },
  { name: "a search number past the list is no answer: ask once", input: { router: routerResult({ act: "refine", targetGroup: 7 }), shown: TWO, groupCount: 3 }, expect: { kind: "which_group", op: "refine" } },
  { name: "'make them all cheaper' is all, said plainly", input: { router: routerResult({ act: "refine", targetGroup: "all" }), shown: TWO, groupCount: 3 }, expect: product("refine") },
  { name: "'the sunscreen' answering which-one, router said refer", input: { router: routerResult({ act: "refer", targetGroup: 2 }), shown: TWO, groupCount: 3, pending: "refine" }, expect: product("refine", { targetGroup: 2, answersPending: true }) },
  { name: "'the sunscreen' answering which-one, router said chat", input: { router: routerResult({ act: "chat", targetGroup: 2 }), shown: TWO, groupCount: 3, pending: "refine" }, expect: product("refine", { targetGroup: 2, answersPending: true }) },
  { name: "a stored question with no search named is not answered", input: { router: routerResult({ act: "new_search", targetGroup: "unclear" }), shown: TWO, groupCount: 3, pending: "refine" }, expect: product("new_search") },

  // Remove one item from a list
  { name: "'remove the eggs' takes that search off the list", input: { router: routerResult({ act: "remove", targetGroup: 1 }), shown: TWO, groupCount: 3 }, expect: { kind: "remove", target: 1 } },
  { name: "'remove one' with no word on which asks once", input: { router: routerResult({ act: "remove", targetGroup: "unclear" }), shown: TWO, groupCount: 3 }, expect: { kind: "which_group", op: "remove" } },
  { name: "'#2' answering which-to-remove removes it", input: { router: routerResult({ act: "refer", targetGroup: 2 }), shown: TWO, groupCount: 3, pending: "remove" }, expect: { kind: "remove", target: 2 } },
  { name: "the only search on screen is not removed: it says so", input: { router: routerResult({ act: "remove" }), shown: TWO, groupCount: 1 }, expect: { kind: "template", reason: "remove_only" } },
];

for (const row of rows) {
  test(`decide: ${row.name}`, () => {
    const input: DecideInput = { text: "", shown: [], groupCount: 0, ...row.input };
    assert.deepEqual(decideAction(input).action, row.expect);
  });
}

test("decide: notes record every override for the trace", () => {
  const byName = decideAction({ router: routerResult({ act: "new_search", referTarget: 2 }), text: "tell me about the iPhone", shown: TWO, groupCount: 1 });
  assert.deepEqual(byName.notes, { referByName: 2 });
});

test("decide: 'show more' words are a closed set; anything after them changes the search", () => {
  for (const t of ["show more", "show me more", "show more please", "more results", "next ones", "more of these", "More!"]) assert.ok(MORE_RE.test(t), t);
  for (const t of ["show me more expensive", "show more red", "show me more samsung", "more expensive ones"]) assert.ok(!MORE_RE.test(t), t);
});

test("decide: a named position is 'the second one' or '#3', never 'a second phone case'", () => {
  assert.equal(namedPosition("tell me about the second one"), 2);
  assert.equal(namedPosition("#3"), 3);
  assert.equal(namedPosition("number 4 please"), 4);
  assert.equal(namedPosition("the third?"), 3);
  assert.equal(namedPosition("tell me about it"), null);
  assert.equal(namedPosition("a second phone case"), null);
  assert.equal(namedPosition("iphone 15"), null);
});
