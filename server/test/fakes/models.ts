// Scripted fakes for the three model ports: RouterClient, SlotClient, ReplyWriter.
//
// Each fake is a FIFO of steps. One step is consumed per call; an empty queue throws, so a turn that
// calls a model nobody scripted fails loudly instead of passing by accident.
//
//   const router = createFakeRouter();
//   router.queue(routerResult({ act: "refine" }));       // a value: returned
//   router.queue(new CallFailed("timeout", "slow"));     // an Error: thrown
//   router.queue(async (input, ctx) => routerResult());  // a function: may be slow, read ctx.signal, or throw
//
//   router.calls   // every call: { input, signal }, in order (also .signal.aborted after the fact)
//   log            // optional shared string[]; each fake pushes "router:start" / "router:end" etc.,
//                  // so a test can assert both calls started before either finished.
//
// gate() gives a promise you open by hand; hangUntilAborted(signal) never resolves unless aborted.
import type {
  ExtractedIntent, ExtractionResult, ProductCard, RouterResult,
} from "../../src/messages/schema.ts";
import type {
  Budget, ExtractInput, ProseInput, ReplyWriter, RouterClient, RouterInput, SlotClient, TraceSink,
} from "../../src/pipeline/ports.ts";

type Ctx = { budget: Budget; trace: TraceSink; signal?: AbortSignal };
export type Step<I, O> = O | Error | ((input: I, ctx: Ctx) => O | Promise<O>);

export type Call<I> = { input: I; signal: AbortSignal | undefined };
export type Fake<C, I, O> = C & {
  calls: Call<I>[];
  queue(...steps: Step<I, O>[]): void;
};

function makeSteps<I, O>(name: string, log: string[] | undefined) {
  const steps: Step<I, O>[] = [];
  const calls: Call<I>[] = [];
  async function next(input: I, ctx: Ctx): Promise<O> {
    calls.push({ input, signal: ctx.signal });
    log?.push(`${name}:start`);
    try {
      const step = steps.shift();
      if (step === undefined) throw new Error(`fake ${name} has no scripted step for call ${calls.length}`);
      if (step instanceof Error) throw step;
      return typeof step === "function" ? await (step as (i: I, c: Ctx) => O | Promise<O>)(input, ctx) : step;
    } finally {
      log?.push(`${name}:end`);
    }
  }
  return { steps, calls, next };
}

export function createFakeRouter(log?: string[]): Fake<RouterClient, RouterInput, RouterResult> {
  const s = makeSteps<RouterInput, RouterResult>("router", log);
  return { calls: s.calls, queue: (...x) => void s.steps.push(...x), route: (input, ctx) => s.next(input, ctx) };
}

export function createFakeSlots(log?: string[]): Fake<SlotClient, ExtractInput, ExtractionResult> {
  const s = makeSteps<ExtractInput, ExtractionResult>("extract", log);
  return { calls: s.calls, queue: (...x) => void s.steps.push(...x), extract: (input, ctx) => s.next(input, ctx) };
}

// The real writer never throws and returns null on failure, so a thrown step is turned into null here.
export function createFakeWriter(log?: string[]): Fake<ReplyWriter, ProseInput, string | null> {
  const s = makeSteps<ProseInput, string | null>("writer", log);
  return {
    calls: s.calls,
    queue: (...x) => void s.steps.push(...x),
    write: (input, ctx) => s.next(input, ctx).catch(() => null),
  };
}

// ---- builders ----

export function routerResult(over: Partial<RouterResult> = {}): RouterResult {
  return {
    refused: false, act: "new_search", domain: "catalog", chatKind: "greeting", mentionsService: false,
    targetGroup: null, referTarget: null,
    answers: { act: { value: over.act ?? "new_search", probability: 0.9, refused: false } },
    ...over,
  };
}

export function intent(over: Partial<ExtractedIntent> = {}): ExtractedIntent {
  return {
    category: null, noun: null, attributes: null, priceMin: null, priceMax: null, currency: null,
    relativePrice: null, sort: null, inStock: null, clear: [], exclude: null, gift: null, ...over,
  };
}

export function extraction(intents: ExtractedIntent[], droppedIntentCount = 0): ExtractionResult {
  return { refused: false, extraction: { intents, droppedIntentCount } };
}

// ---- timing helpers ----

export function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

export function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return; // no signal: hangs forever, which is what a test using this wants to see fail
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

export type { ProductCard };
