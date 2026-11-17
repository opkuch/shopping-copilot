import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { callWithRetry } from "../llm/call.ts";
import { ExtractedIntent, MAX_GROUPS } from "../messages/schema.ts";
import type { ExtractionResult } from "../messages/schema.ts";
import { CallFailed } from "../pipeline/ports.ts";
import type { ExtractInput, SlotClient } from "../pipeline/ports.ts";
import { MODEL, readResponse } from "../llm/openai.ts";
import type { ResponseLike, ResponsesClient } from "../llm/openai.ts";
import { turnContext } from "../prompts/context.ts";
import { EXTRACT_INSTRUCTIONS, VERSION } from "../prompts/extract.ts";

// The contract's Extraction caps intents at MAX_GROUPS. Here the model-facing schema has no cap, so an
// over-long answer is sliced by us instead of failing the whole turn on a schema error.
const ModelExtraction = z.object({
  intents: z.array(ExtractedIntent),
  droppedIntentCount: z.number().int(),
});

// zodTextFormat supports zod v4 in the installed SDK, so it builds the strict JSON schema.
// We still validate with Zod ourselves (parseExtractionResponse) rather than use responses.parse,
// so the same code path replays recorded bodies and a bad body becomes CallFailed("parse").
const FORMAT = zodTextFormat(ModelExtraction, "extraction");

export function parseExtractionResponse(response: ResponseLike): ExtractionResult {
  const { refusal, text } = readResponse(response);
  if (refusal !== null) return { refused: true };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CallFailed("parse", "extraction output is not valid JSON");
  }
  const parsed = ModelExtraction.safeParse(json);
  if (!parsed.success) throw new CallFailed("parse", `extraction output failed validation: ${parsed.error.message}`);
  return {
    refused: false,
    extraction: {
      intents: parsed.data.intents.slice(0, MAX_GROUPS),
      // The model's own count, or the intents cut here, whichever is more: a 7th intent sent with a count of 0
      // is still dropped, and the reply must say so.
      droppedIntentCount: Math.max(0, parsed.data.droppedIntentCount, parsed.data.intents.length - MAX_GROUPS),
    },
  };
}

export function buildExtractInput(input: ExtractInput): ResponseCreateParamsNonStreaming["input"] {
  return [
    { role: "developer", content: EXTRACT_INSTRUCTIONS },
    { role: "user", content: `Context:\n${turnContext(input)}\n\nLatest message:\n${input.utterance}` },
  ];
}

export function createSlotClient(client: ResponsesClient, opts: { timeoutMs?: number } = {}): SlotClient {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  return {
    async extract(input, ctx) {
      const body: ResponseCreateParamsNonStreaming = {
        model: MODEL,
        input: buildExtractInput(input),
        reasoning: { effort: "low" },
        text: { format: FORMAT },
      };
      const response = await callWithRetry(
        (signal) => client.responses.create(body, { signal, maxRetries: 0, timeout: ctx.budget.timeoutFor(timeoutMs) }),
        { name: "extract", timeoutMs, budget: ctx.budget, trace: ctx.trace, signal: ctx.signal },
      );
      const result = parseExtractionResponse(response);
      ctx.trace.event("extract", { prompt: VERSION, result });
      return result;
    },
  };
}
