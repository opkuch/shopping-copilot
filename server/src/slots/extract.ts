import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { callWithRetry } from "../llm/call.ts";
import { ExtractedIntent } from "../messages/schema.ts";
import type { ExtractionResult } from "../messages/schema.ts";
import { CallFailed } from "../pipeline/ports.ts";
import type { ExtractInput, SlotClient } from "../pipeline/ports.ts";
import { describeMemory } from "../pipeline/purpose.ts";
import { EXTRACT_INSTRUCTIONS, VERSION } from "../prompts/extract.ts";

const MODEL = "gpt-6-luna";

// The contract's Extraction caps intents at 2. Here the model-facing schema has no cap, so an
// over-long answer is sliced by us instead of failing the whole turn on a schema error.
const ModelExtraction = z.object({
  intents: z.array(ExtractedIntent),
  droppedIntentCount: z.number().int(),
});

// zodTextFormat supports zod v4 in the installed SDK, so it builds the strict JSON schema.
// We still validate with Zod ourselves (parseExtractionResponse) rather than use responses.parse,
// so the same code path replays recorded bodies and a bad body becomes CallFailed("parse").
const FORMAT = zodTextFormat(ModelExtraction, "extraction");

export type ResponseLike = { output?: unknown; output_text?: unknown };

/** Reads the refusal or the concatenated output text out of a Responses body. */
export function readResponse(response: ResponseLike): { refusal: string | null; text: string } {
  let text = "";
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output as Array<{ type?: string; content?: unknown }>) {
    if (item?.type === "refusal") return { refusal: "refusal", text: "" };
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ type?: string; text?: unknown; refusal?: unknown }>) {
      if (part?.type === "refusal") return { refusal: typeof part.refusal === "string" ? part.refusal : "refusal", text: "" };
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  if (text === "" && typeof response.output_text === "string") text = response.output_text;
  return { refusal: null, text };
}

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
      intents: parsed.data.intents.slice(0, 2),
      droppedIntentCount: Math.max(0, parsed.data.droppedIntentCount),
    },
  };
}

export function buildExtractInput(input: ExtractInput): ResponseCreateParamsNonStreaming["input"] {
  const context = { previousExchange: input.previous ?? null, conversation: describeMemory(input.memory ?? null), storedQueries: input.storedQueries, shownCards: input.shownCards };
  return [
    { role: "developer", content: EXTRACT_INSTRUCTIONS },
    { role: "user", content: `Context:\n${JSON.stringify(context)}\n\nLatest message:\n${input.utterance}` },
  ];
}

export type ResponsesClient = {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      opts: { signal: AbortSignal; maxRetries: number; timeout: number },
    ): Promise<ResponseLike>;
  };
};

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
