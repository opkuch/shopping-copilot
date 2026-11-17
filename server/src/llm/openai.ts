import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

/** The only model the assignment allows; every call names it from here. */
export const MODEL = "gpt-6-luna";

// maxRetries is 0 on purpose: retries are ours (callWithRetry), so the trace shows every attempt
// and the SDK cannot stack a second retry on top of ours.
export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, maxRetries: 0 });
}

export type ResponseLike = { output?: unknown; output_text?: unknown };

/** The part of the OpenAI client the Responses callers use, so tests can pass a fake. */
export type ResponsesClient = {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      opts: { signal: AbortSignal; maxRetries: number; timeout: number },
    ): Promise<ResponseLike>;
  };
};

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
