import { raceAbort } from "../llm/call.ts";
import { CallFailed } from "../pipeline/ports.ts";
import type { ProseInput, ReplyWriter } from "../pipeline/ports.ts";
import { PROSE_INSTRUCTIONS, RESULTS_INSTRUCTIONS, VERSION } from "../prompts/prose.ts";
import { readResponse } from "../slots/extract.ts";
import { LANGUAGE_NAME } from "./language.ts";
import type { ResponsesClient } from "../slots/extract.ts";

const MODEL = "gpt-6-luna";
const MIN_REMAINING_MS = 4000;
const MAX_CHARS = 400;

export function facts(input: ProseInput): unknown {
  if (input.kind === "refer") return { language: LANGUAGE_NAME[input.language], message: input.message, product: input.detail };
  return {
    language: LANGUAGE_NAME[input.language],
    message: input.message,
    previous: input.previous,
    groups: input.groups,
    draft: input.draft,
  };
}

const cents = (n: number) => Math.round(n * 100);

function amountsIn(text: string): number[] {
  const found: number[] = [];
  // "$149.99", "$ 1,399.99", and "149.99$" (the dollar sign follows the number in some Hebrew text)
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?\$/g)) {
    const n = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) found.push(cents(n));
  }
  return found;
}

/** Every amount a reply may quote: card prices, the bounds that were asked, and amounts in the draft. */
function allowedAmounts(input: ProseInput): Set<number> {
  const out = new Set<number>();
  if (input.kind === "refer") return out.add(cents(input.detail.price));
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

/**
 * A reply that reverses what code decided: the draft says a shekel limit was converted and applied, and
 * the model wrote that it was not applied (live: "והבקשה עד 5,000 ₪ לא הוחלה" under cards
 * filtered to $1,351). Amount checks cannot see this, so the template is shown instead.
 */
export function contradictsDraft(text: string, input: ProseInput): boolean {
  if (input.kind !== "results") return false;
  const converted = /converted shekels|המרתי משקלים/.test(input.draft);
  return converted && /not applied|didn't apply|did not apply|wasn't applied|לא הוחל|לא החלתי|לא יושמ/i.test(text);
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
                { role: "developer", content: input.kind === "refer" ? PROSE_INSTRUCTIONS : RESULTS_INSTRUCTIONS },
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
        if (trimmed.length > MAX_CHARS) return done("too_long", { chars: trimmed.length }), null;
        const invented = ungroundedAmounts(trimmed, input);
        if (invented.length > 0) return done("ungrounded", { amounts: invented, text: trimmed }), null;
        if (contradictsDraft(trimmed, input)) return done("contradicts_draft", { text: trimmed }), null;
        done("ok");
        return trimmed;
      } catch (err) {
        done("error", { error: err instanceof CallFailed ? err.kind : err instanceof Error ? err.name : "unknown" });
        return null;
      }
    },
  };
}
