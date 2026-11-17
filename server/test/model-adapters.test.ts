import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import OpenAI from "openai";
import type { Decision } from "openai/resources/decisions";
import { buildInput, buildQuestions, createRouterClient, parseDecision } from "../src/router/classify.ts";
import { createSlotClient, parseExtractionResponse } from "../src/slots/extract.ts";
import { createBudget } from "../src/pipeline/budget.ts";
import { VERSION as ROUTER_VERSION } from "../src/prompts/router.ts";
import { CallFailed } from "../src/pipeline/ports.ts";
import type { RouterInput, TraceSink } from "../src/pipeline/ports.ts";
import type { Query } from "../src/messages/schema.ts";

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/model/${name}.json`, import.meta.url), "utf8")) as T;
const trace: TraceSink = { event() {} };

const query: Query = { category: "laptops", noun: null, attributes: [], priceMin: null, priceMax: null, sort: "relevance", inStock: false, gender: null, categoryStated: false, top: false, within: null, purpose: null, exclude: [], offset: 0 };
const cards = [
  { index: 1, id: 1, title: "Laptop A", category: "laptops", price: 999 },
  { index: 2, id: 2, title: "Rolex", category: "mens-watches", price: 5000 },
];
const bare: RouterInput = { utterance: "red laptop", storedQueries: [], shownCards: [] };
const oneGroup: RouterInput = { utterance: "cheaper", storedQueries: [{ label: "Laptops", query }], shownCards: cards };
const twoGroups: RouterInput = {
  utterance: "cheaper",
  storedQueries: [{ label: "Laptops", query }, { label: "Watches", query }],
  shownCards: cards,
};

const names = (input: RouterInput) => buildQuestions(input).map((q) => q.name);

test("buildQuestions: dynamic set", () => {
  assert.deepEqual(names(bare), ["act", "domain", "chat_kind", "mentions_service"]);
  assert.deepEqual(names(oneGroup), ["act", "domain", "chat_kind", "mentions_service", "refer_target"]);
  assert.deepEqual(names(twoGroups), ["act", "domain", "chat_kind", "mentions_service", "target_group", "refer_target"]);
  // two groups but no cards (e.g. both groups missed): no refer question
  assert.deepEqual(names({ ...twoGroups, shownCards: [] }), ["act", "domain", "chat_kind", "mentions_service", "target_group"]);
});

test("buildQuestions: every choice has a description; refer choices list cards and unclear", () => {
  for (const q of buildQuestions(twoGroups)) {
    if (q.type !== "choice") continue;
    for (const c of q.choices) assert.ok(c.description, `${q.name}/${String(c.value)}`);
  }
  const refer = buildQuestions(oneGroup).find((q) => q.name === "refer_target");
  assert.equal(refer?.type, "choice");
  if (refer?.type !== "choice") return;
  assert.deepEqual(refer.choices.map((c) => c.value), ["card_1", "card_2", "unclear"]);
  assert.equal(refer.choices[1]?.description, "Rolex — mens-watches — $5000");
});

test("buildInput: instructions first, utterance last", () => {
  const input = buildInput(twoGroups);
  assert.ok(Array.isArray(input));
  assert.deepEqual(input[0], { role: "developer", content: (input[0] as { content: string }).content });
  assert.match((input[0] as { content: string }).content, /classify/);
  const user = input[1] as { content: Array<{ text: string }> };
  assert.match(user.content[0]!.text, /Rolex/);
  assert.match(user.content.at(-1)!.text, /cheaper$/);
});

test("fixture: search decision", () => {
  const r = parseDecision(fixture<Decision>("decision-search"), bare);
  assert.equal(r.refused, false);
  assert.equal(r.act, "new_search");
  assert.equal(r.domain, "catalog");
  assert.equal(r.mentionsService, false);
  assert.equal(r.targetGroup, null);
  assert.equal(r.referTarget, null);
  assert.deepEqual(r.answers.act, { value: "new_search", probability: 0.97, refused: false });
  assert.deepEqual(r.answers.mentions_service, { value: false, probability: 0.08, refused: false });
});

test("fixture: refusal on act means refused", () => {
  const r = parseDecision(fixture<Decision>("decision-refusal-act"), bare);
  assert.equal(r.refused, true);
  assert.deepEqual(r.answers.act, { value: null, probability: null, refused: true });
});

test("fixture: refusal on target_group degrades to unclear", () => {
  const r = parseDecision(fixture<Decision>("decision-refusal-target"), twoGroups);
  assert.equal(r.refused, false);
  assert.equal(r.act, "refine");
  assert.equal(r.targetGroup, "unclear");
  assert.equal(r.referTarget, "unclear");
});

test("fixture: refer card_2 becomes 2", () => {
  const r = parseDecision(fixture<Decision>("decision-refer"), twoGroups);
  assert.equal(r.act, "refer");
  assert.equal(r.referTarget, 2);
  assert.equal(r.answers.refer_target?.probability, 0.91);
});

const withAnswers = (base: Decision, patch: (a: Decision["answers"][number]) => unknown): Decision =>
  ({ ...base, answers: base.answers.map((a) => patch(a)) }) as Decision;

test("router: missing act answer is CallFailed parse, not a refusal", () => {
  const base = fixture<Decision>("decision-search");
  const d = { ...base, answers: base.answers.filter((a) => a.name !== "act") } as Decision;
  assert.throws(() => parseDecision(d, bare), (e) => e instanceof CallFailed && e.kind === "parse");
});

test("router: unknown act value is CallFailed parse", () => {
  const d = withAnswers(fixture<Decision>("decision-search"), (a) => (a.name === "act" ? { ...a, choice: "dance" } : a));
  assert.throws(() => parseDecision(d, bare), (e) => e instanceof CallFailed && e.kind === "parse");
});

test("router: refusal on domain is refused", () => {
  const d = withAnswers(fixture<Decision>("decision-search"), (a) =>
    a.name === "domain" ? { type: "refusal", name: "domain", reason: "no" } : a);
  const r = parseDecision(d, bare);
  assert.equal(r.refused, true);
  assert.equal(r.answers.domain?.refused, true);
});

test("router: unknown target_group value degrades to unclear and is not a refusal", () => {
  const d = withAnswers(fixture<Decision>("decision-refer"), (a) => (a.name === "target_group" ? { ...a, choice: "third" } : a));
  const r = parseDecision(d, twoGroups);
  assert.equal(r.refused, false);
  assert.equal(r.targetGroup, "unclear");
  assert.equal(r.answers.target_group?.refused, false);
});

test("router: missing optional answers degrade to fallbacks; invented card is unclear", () => {
  const base = fixture<Decision>("decision-refer");
  const r = parseDecision({ ...base, answers: base.answers.filter((a) => a.name === "act" || a.name === "domain") } as Decision, twoGroups);
  assert.equal(r.refused, false);
  assert.equal(r.chatKind, "greeting");
  assert.equal(r.mentionsService, false);
  assert.equal(r.targetGroup, "unclear");
  assert.equal(r.referTarget, "unclear");
  const bogus = withAnswers(base, (a) => (a.name === "refer_target" ? { ...a, choice: "card_9" } : a));
  assert.equal(parseDecision(bogus, twoGroups).referTarget, "unclear");
});

test("router client: malformed act surfaces CallFailed parse without retrying", async () => {
  const base = fixture<Decision>("decision-search");
  let calls = 0;
  const client = createRouterClient({
    decisions: { create: async () => { calls++; return { ...base, answers: [] } as Decision; } },
  });
  await assert.rejects(client.route(bare, { budget: createBudget(10000), trace }),
    (e) => e instanceof CallFailed && e.kind === "parse");
  assert.equal(calls, 1);
});

test("fixture: extraction response", () => {
  const r = parseExtractionResponse(fixture("response-extraction"));
  assert.ok(!r.refused);
  if (r.refused) return;
  assert.equal(r.extraction.intents[0]?.category, "laptops");
  assert.equal(r.extraction.intents[0]?.priceMax, 1000);
  assert.equal(r.extraction.droppedIntentCount, 0);
});

test("fixture: refusal output is refused", () => {
  assert.deepEqual(parseExtractionResponse(fixture("response-refusal")), { refused: true });
});

test("fixture: bad JSON and bad schema throw CallFailed parse", () => {
  assert.throws(() => parseExtractionResponse(fixture("response-bad-json")), (e) => e instanceof CallFailed && e.kind === "parse");
  const wrongShape = { output: [{ type: "message", content: [{ type: "output_text", text: '{"intents":[{"category":"cars"}],"droppedIntentCount":0}' }] }] };
  assert.throws(() => parseExtractionResponse(wrongShape), (e) => e instanceof CallFailed && e.kind === "parse");
});

test("extraction slices intents to MAX_GROUPS (6) and counts the cut ones as dropped, whatever the model said", () => {
  // The recorded body may start with a reasoning item; the extraction is the message item's text.
  const good = (fixture<{ output: Array<{ content?: Array<{ text: string }> }> }>("response-extraction")).output.find((o) => (o as { type?: string }).type === "message")!.content![0]!.text;
  const intent = (JSON.parse(good) as { intents: unknown[] }).intents[0];
  const body = (text: unknown) => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(text) }] }] });
  const r = parseExtractionResponse(body({ intents: Array.from({ length: 8 }, () => intent), droppedIntentCount: -3 }));
  assert.ok(!r.refused);
  if (r.refused) return;
  assert.equal(r.extraction.intents.length, 6);
  // 8 sent, 6 kept: 2 dropped even though the model reported -3 (and the same for a reported 0)
  assert.equal(r.extraction.droppedIntentCount, 2);
  const seven = parseExtractionResponse(body({ intents: Array.from({ length: 7 }, () => intent), droppedIntentCount: 0 }));
  assert.ok(!seven.refused && seven.extraction.droppedIntentCount === 1);
  // a count larger than the cut is kept: the model may have dropped items before writing intents
  const told = parseExtractionResponse(body({ intents: [intent], droppedIntentCount: 2 }));
  assert.ok(!told.refused && told.extraction.droppedIntentCount === 2);
});

test("router client passes model gpt-6-luna and maxRetries 0, traces the prompt version", async () => {
  const seen: Array<{ body: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const client = createRouterClient({
    decisions: {
      create: async (body, opts) => (seen.push({ body: body as never, opts: opts as never }), fixture<Decision>("decision-refer")),
    },
  });
  const r = await client.route(twoGroups, { budget: createBudget(), trace: { event: (kind, data) => void events.push({ kind, data }) } });
  assert.equal(r.referTarget, 2);
  assert.equal(seen[0]?.body.model, "gpt-6-luna");
  assert.equal(seen[0]?.opts.maxRetries, 0);
  assert.ok(seen[0]?.opts.signal instanceof AbortSignal);
  assert.equal(events.find((e) => e.kind === "router")?.data.prompt, ROUTER_VERSION);
});

test("slot client passes model, reasoning low, strict format, maxRetries 0", async () => {
  const seen: Array<{ body: Record<string, any>; opts: Record<string, unknown> }> = [];
  const client = createSlotClient({
    responses: { create: async (body, opts) => (seen.push({ body: body as never, opts: opts as never }), fixture("response-extraction")) },
  });
  const r = await client.extract(bare, { budget: createBudget(), trace });
  assert.equal(r.refused, false);
  assert.equal(seen[0]?.body.model, "gpt-6-luna");
  assert.deepEqual(seen[0]?.body.reasoning, { effort: "low" });
  assert.equal(seen[0]?.body.text.format.strict, true);
  assert.equal(seen[0]?.opts.maxRetries, 0);
});

test("the real SDK client satisfies the adapter client types", () => {
  const openai = new OpenAI({ apiKey: "test", maxRetries: 0 });
  createRouterClient(openai);
  createSlotClient(openai);
});

test("router: which search is a choice per search on screen, read as its number; a low-confidence pick is unclear", () => {
  const three: RouterInput = { ...twoGroups, storedQueries: [...twoGroups.storedQueries, { label: "Eggs", query }] };
  const q = buildQuestions(three).find((x) => x.name === "target_group") as { choices: Array<{ value: string; description: string }> };
  assert.deepEqual(q.choices.map((c) => c.value), ["group_1", "group_2", "group_3", "all", "unclear"]);
  assert.equal(q.choices[2]?.description, "3. Eggs");
  const pick = (choice: string, confidence: number) => parseDecision(withAnswers(fixture<Decision>("decision-refer"), (a) => (a.name === "target_group" ? { ...a, choice, confidence } : a)), three).targetGroup;
  assert.equal(pick("group_3", 0.9), 3);
  assert.equal(pick("all", 0.9), "all");
  assert.equal(pick("group_3", 0.4), "unclear", "below the measured confidence floor");
  assert.equal(pick("group_9", 0.9), "unclear", "a search that isn't on screen");
});
