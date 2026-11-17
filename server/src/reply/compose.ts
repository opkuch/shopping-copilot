// The reply writer: a model words a reply from facts code has already decided, and code checks the wording.
import { raceAbort } from "../llm/call.ts";
import { MODEL, readResponse } from "../llm/openai.ts";
import type { ResponsesClient } from "../llm/openai.ts";
import { CallFailed } from "../pipeline/ports.ts";
import type { ProseInput, ReplyWriter } from "../pipeline/ports.ts";
import { ANSWER_INSTRUCTIONS, PROSE_INSTRUCTIONS, RESULTS_INSTRUCTIONS, VERSION } from "../prompts/prose.ts";

const MIN_REMAINING_MS = 4000;
const MAX_CHARS = 400;
/** An answer about several products may compare them, so it gets more room. */
const MAX_ANSWER_CHARS = 600;
const maxChars = (input: ProseInput) => (input.kind === "answer" ? MAX_ANSWER_CHARS : MAX_CHARS);

const INSTRUCTIONS: Record<ProseInput["kind"], string> = { refer: PROSE_INSTRUCTIONS, answer: ANSWER_INSTRUCTIONS, results: RESULTS_INSTRUCTIONS };

/** What the model reads: only the facts, never anything it could take as a fact that isn't one. */
export function facts(input: ProseInput): unknown {
  if (input.kind === "refer") return { message: input.message, product: input.detail };
  if (input.kind === "answer") {
    // The card image and the stored-card marker mean nothing to a reader of the listing.
    const products = input.products.map(({ thumbnail: _t, source: _s, ...p }) => p);
    return { message: input.message, previous: input.previous, products };
  }
  return { message: input.message, previous: input.previous, groups: input.groups, draft: input.draft };
}

const cents = (n: number) => Math.round(n * 100);

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
// An amount of money however it is written: "$50", "50$", "50 dollars", "50 bucks", "50 USD", "USD 50".
const MONEY = new RegExp(String.raw`\$\s?${NUM}|${NUM}\s?(?:\$|dollars?\b|bucks\b|usd\b)|\busd\s?${NUM}`, "gi");

function amountsIn(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const n = Number((m[1] ?? m[2] ?? m[3] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) found.push(cents(n));
  }
  return found;
}

// A number the shopper wrote as a price: an amount of money, or a number after a price word ("under 50",
// "around 30", "between 20 and 40"). Not a model or a count: "an iPhone 15" must not let the reply say "$15".
const PRICED = new RegExp(
  String.raw`(?:under|below|over|above|less\s+than|more\s+than|up\s+to|max(?:imum)?|budget(?:\s+of)?|between|and|around|about|roughly|for|at|~)\s*\$?\s*${NUM}`,
  "gi",
);

/**
 * Every amount a reply may quote: product and card prices, the bounds that were asked, amounts in the draft,
 * and the prices the shopper typed ("around 30 bucks" may be answered with "around $30").
 */
function allowedAmounts(input: ProseInput): Set<number> {
  const out = new Set<number>(amountsIn(input.message));
  for (const m of input.message.matchAll(PRICED)) {
    const n = Number((m[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(cents(n));
  }
  if (input.kind === "refer") return out.add(cents(input.detail.price));
  if (input.kind === "answer") {
    for (const p of input.products) out.add(cents(p.price));
    return out;
  }
  for (const g of input.groups) {
    for (const c of g.cards) out.add(cents(c.price));
    if (g.request.priceMin !== null) out.add(cents(g.request.priceMin));
    if (g.request.priceMax !== null) out.add(cents(g.request.priceMax));
  }
  for (const a of amountsIn(input.draft)) out.add(a);
  return out;
}

/**
 * The model words the reply; it must not supply facts. A price it quotes that is not a card price,
 * an asked bound, or in the draft is an invented number, and the whole reply is dropped for the template.
 */
export function ungroundedAmounts(text: string, input: ProseInput): number[] {
  const allowed = allowedAmounts(input);
  return amountsIn(text).filter((a) => !allowed.has(a)).map((a) => a / 100);
}

// No retries: the cards are the result, and a template is always available.
export function createReplyWriter(client: ResponsesClient, opts: { timeoutMs?: number } = {}): ReplyWriter {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return {
    async write(input, ctx) {
      if (ctx.budget.remaining() < MIN_REMAINING_MS) {
        ctx.trace.event("prose_skipped", { kind: input.kind, remainingMs: Math.round(ctx.budget.remaining()) });
        return null;
      }
      const started = performance.now();
      const done = (outcome: string, extra: Record<string, unknown> = {}) =>
        ctx.trace.event("prose", { prompt: VERSION, kind: input.kind, outcome, ms: Math.round(performance.now() - started), ...extra });
      try {
        const timeout = ctx.budget.timeoutFor(timeoutMs);
        const signal = AbortSignal.timeout(timeout);
        const response = await raceAbort(
          client.responses.create(
            {
              model: MODEL,
              input: [
                { role: "developer", content: INSTRUCTIONS[input.kind] },
                { role: "user", content: JSON.stringify(facts(input)) },
              ],
              reasoning: { effort: "low" },
            },
            { signal, maxRetries: 0, timeout },
          ),
          signal,
        );
        const { refusal, text } = readResponse(response);
        const trimmed = text.trim();
        if (refusal !== null) return done("refused"), null;
        if (trimmed === "") return done("empty"), null;
        if (trimmed.length > maxChars(input)) return done("too_long", { chars: trimmed.length }), null;
        const invented = ungroundedAmounts(trimmed, input);
        if (invented.length > 0) return done("ungrounded", { amounts: invented, text: trimmed }), null;
        done("ok");
        return trimmed;
      } catch (err) {
        done("error", { error: err instanceof CallFailed ? err.kind : err instanceof Error ? err.name : "unknown" });
        return null;
      }
    },
  };
}
