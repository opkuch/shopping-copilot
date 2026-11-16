import OpenAI from "openai";

// maxRetries is 0 on purpose: retries are ours (callWithRetry), so the trace shows every attempt
// and the SDK cannot stack a second retry on top of ours.
export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, maxRetries: 0 });
}
