// Records raw model response bodies into test/fixtures/model/ (`npm run record:model`).
// It drives the production adapters through a capturing wrapper, so the recorded request is exactly
// the one the app sends and the body is exactly what the parsers will be replayed against.
// Refusals are not recorded: the model does not refuse on demand, so decision-refusal-*.json and
// response-refusal.json stay hand-written (see test/fixtures/model/README.md).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBudget } from "../src/pipeline/budget.ts";
import type { RouterInput, StoredQuery, TraceSink } from "../src/pipeline/ports.ts";
import { createRouterClient } from "../src/router/classify.ts";
import type { DecisionsClient } from "../src/router/classify.ts";
import { createSlotClient } from "../src/slots/extract.ts";
import type { ResponsesClient } from "../src/slots/extract.ts";

export type FixtureTarget = { name: string; kind: "decision" | "extraction"; input: RouterInput };

const laptops: StoredQuery = { label: "Laptops", query: { category: "laptops", noun: null, attributes: [], priceMin: null, priceMax: null, sort: "price_asc", inStock: false, gender: null, categoryStated: false, top: false, within: null, purpose: null, offset: 0 } };

export function fixtureTargets(): FixtureTarget[] {
  const search: RouterInput = { utterance: "a red laptop under 1000", storedQueries: [], shownCards: [] };
  const refer: RouterInput = {
    utterance: "tell me more about the Rolex",
    storedQueries: [laptops],
    shownCards: [
      { index: 1, id: 81, title: "Lenovo Yoga 920", category: "laptops", price: 1099.99 },
      { index: 2, id: 97, title: "Rolex Datejust", category: "mens-watches", price: 10999.99 },
    ],
  };
  return [
    { name: "decision-search", kind: "decision", input: search },
    { name: "decision-refer", kind: "decision", input: refer },
    { name: "response-extraction", kind: "extraction", input: search },
  ];
}

export async function recordFixtures(deps: {
  decisions: DecisionsClient;
  responses: ResponsesClient;
  write: (name: string, body: unknown) => void;
  sleep: (ms: number) => Promise<void>;
  gapMs?: number;
}): Promise<string[]> {
  const trace: TraceSink = { event() {} };
  const recorded: Array<{ name: string; body: unknown }> = [];
  let last: unknown;
  const decisions: DecisionsClient = {
    decisions: { create: async (body, opts) => (last = await deps.decisions.decisions.create(body, opts)) },
  };
  const responses: ResponsesClient = {
    responses: { create: async (body, opts) => (last = await deps.responses.responses.create(body, opts)) },
  };
  const router = createRouterClient(decisions);
  const slots = createSlotClient(responses);

  for (const target of fixtureTargets()) {
    const ctx = { budget: createBudget(60_000), trace };
    if (target.kind === "decision") await router.route(target.input, ctx);
    else await slots.extract(target.input, ctx);
    recorded.push({ name: target.name, body: last });
    await deps.sleep(deps.gapMs ?? 1100);
  }
  // Written only once every call has succeeded, so a failure never leaves a half-replaced set.
  for (const r of recorded) deps.write(r.name, r.body);
  return recorded.map((r) => r.name);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set. Put it in .env or export it, then run `npm run record:model` again.");
    process.exitCode = 1;
    return;
  }
  const { createOpenAIClient } = await import("../src/llm/openai.ts");
  const client = createOpenAIClient(apiKey);
  const dir = fileURLToPath(new URL("../test/fixtures/model/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const names = await recordFixtures({
    decisions: client as unknown as DecisionsClient,
    responses: client as unknown as ResponsesClient,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    write: (name, body) => writeFileSync(`${dir}${name}.json`, JSON.stringify(body, null, 2) + "\n"),
  });
  console.log(`Recorded: ${names.join(", ")}. Refusal fixtures are not recorded; they stay hand-written.`);
}

if (import.meta.main) await main();
