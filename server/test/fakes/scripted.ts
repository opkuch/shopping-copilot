// Table-driven model fakes for the browser test server (scripts/serve-fake.ts).
//
// The FIFO fakes in models.ts answer calls in the order a test queued them. A browser sends messages
// in any order, so these fakes answer by looking up the utterance instead. The rows are a contract
// with web/e2e, and test/scripted.test.ts locks what each one produces.
import type { ExtractionResult, RouterResult } from "../../src/messages/schema.ts";
import type { ExtractInput, RouterInput, RouterClient, SlotClient } from "../../src/pipeline/ports.ts";
import { CallFailed } from "../../src/pipeline/ports.ts";
import { extraction, intent, routerResult } from "./models.ts";

type Row = {
  router: RouterResult;
  extraction: ExtractionResult;
  /** Every odd-numbered call for this utterance fails, so each send fails once and its retry succeeds. */
  failEveryOtherCall?: boolean;
  /** The router answers after this delay, so a test can reload mid-turn. */
  slow?: boolean;
};

const NO_INTENTS = extraction([]);
const laptops = extraction([intent({ category: "laptops" })]);

export const SCRIPT: Record<string, Row> = {
  "cheap sunglasses": {
    router: routerResult({ act: "new_search", domain: "catalog" }),
    extraction: extraction([intent({ category: "sunglasses", sort: "price_asc" })]),
  },
  "a laptop and a fragrance under 50": {
    router: routerResult({ act: "new_search", domain: "catalog" }),
    extraction: extraction([
      intent({ category: "laptops" }),
      intent({ category: "fragrances", priceMax: 50, currency: "USD" }),
    ]),
  },
  "a flight to tokyo": {
    router: routerResult({ act: "new_search", domain: "service" }),
    extraction: NO_INTENTS,
  },
  "tell me about the first one": {
    router: routerResult({ act: "refer", domain: "catalog", referTarget: 1 }),
    extraction: NO_INTENTS,
  },
  "משקפי שמש זולים": {
    router: routerResult({ act: "new_search", domain: "catalog" }),
    extraction: extraction([intent({ category: "sunglasses", sort: "price_asc" })]),
  },
  "ספר לי על הראשון": {
    router: routerResult({ act: "refer", domain: "catalog", referTarget: 1 }),
    extraction: NO_INTENTS,
  },
  "fail once": {
    router: routerResult({ act: "new_search", domain: "catalog" }),
    extraction: laptops,
    failEveryOtherCall: true,
  },
  "slow laptops": {
    router: routerResult({ act: "new_search", domain: "catalog" }),
    extraction: laptops,
    slow: true,
  },
};

const GREETING: Row = { router: routerResult({ act: "chat", domain: "catalog", chatKind: "greeting" }), extraction: NO_INTENTS };

export const normalize = (utterance: string) => utterance.trim().toLowerCase().replace(/\s+/g, " ");
const rowFor = (input: RouterInput | ExtractInput): Row => SCRIPT[normalize(input.utterance)] ?? GREETING;

export function createScriptedModels(opts: { slowMs?: number } = {}): { router: RouterClient; slots: SlotClient } {
  const slowMs = opts.slowMs ?? 3000;
  const calls = new Map<string, number>();
  return {
    router: {
      async route(input) {
        const row = rowFor(input);
        const key = normalize(input.utterance);
        const n = (calls.get(key) ?? 0) + 1;
        calls.set(key, n);
        if (row.failEveryOtherCall && n % 2 === 1) throw new CallFailed("http", "scripted failure", 503);
        if (row.slow) await new Promise((r) => setTimeout(r, slowMs));
        return structuredClone(row.router);
      },
    },
    slots: {
      async extract(input) {
        return structuredClone(rowFor(input).extraction);
      },
    },
  };
}
