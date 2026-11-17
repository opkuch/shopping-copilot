// Simulated-user eval: an LLM shopper with a hidden goal (eval/sim/goals.json) talks to the copilot
// freely, reacting to the reply and the cards it sees, until it finds a product, decides the shop
// doesn't have it, or gives up. Unlike eval:product, the next message depends on the last reply, so a
// wrong turn is followed by a correction, not by a scripted line that assumes everything went right.
//
// Success is checked against the goal, not taken from the simulator: the product the shopper picks
// must be one the goal accepts and must have been on screen. For an impossible goal, success is the
// shopper concluding the shop doesn't sell it.
//
//   npm run eval:sim                        pipeline, 3 runs per goal
//   npm run eval:sim -- --target=baseline   one LLM call per turn with the whole catalog in the prompt (a yardstick)
//   npm run eval:sim -- --only=s01,s04 --runs=1
// Opt-in and paid.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { MODEL } from "../src/llm/openai.ts";

const DIR = new URL("../eval/sim/", import.meta.url);

type Goal = { id: string; goal: string; style: string; accept: number[]; acceptAll?: number[][]; impossible?: boolean; hard?: boolean; maxTurns?: number };
type Card = { id: number; title: string; price: number; category: string; inStock: boolean; rating: number | null };
type Screen = { reply: string; cards: Card[]; suggestions: string[]; detail: Card | null; ms: number };
type Session = { send(text: string): Promise<Screen> };
type Target = { name: string; start(): Promise<Session>; close(): Promise<void> };

const Move = z.object({
  outcome: z.enum(["continue", "found", "not_available", "gave_up"]),
  productIds: z.array(z.number().int()),
  message: z.string(),
});
type Move = z.infer<typeof Move>;

const SIM_INSTRUCTIONS = (g: Goal) => `You play a real shopper chatting with an online shop's assistant. Stay in character.
Your goal (secret, the assistant does not know it): ${g.goal}
How you talk: ${g.style}
Write in English, the way people type in a chat: short, informal, one thing at a time. Never mention that you are simulated or that you have a "goal".
Each turn you see the assistant's last reply, the product cards it showed (id, title, price, rating, in stock), any product detail, and tappable suggestions. React to what you actually see:
- If the assistant asks a question, answer it (briefly).
- If the cards are wrong or off, say so the way a person would, and steer.
- Be a reasonable shopper: a product that fits your goal well enough that most people would buy it counts, even if its name uses other words than yours.
- When a card on screen satisfies your goal, set outcome "found" and productIds to its id (if your goal needs several products, say "found" only once you have them all, and list every id). Only pick a product that is on screen now or was shown earlier in this chat.
- If the assistant clearly tells you the shop doesn't sell what you need, and you believe it, set outcome "not_available".
- If you are going in circles or the assistant keeps getting it wrong, you may give up ("gave_up"), like a real impatient shopper.
- Otherwise outcome "continue" with your next message in "message".
For the very first turn there is no reply yet: write your opening message.`;

function describe(s: Screen): string {
  const cards = s.cards.map((c) => `  [${c.id}] ${c.title} — $${c.price}${c.rating === null ? "" : `, rated ${c.rating}`}${c.inStock ? "" : " (out of stock)"}`).join("\n");
  return [
    `Assistant: ${s.reply || "(no text)"}`,
    s.cards.length ? `Cards:\n${cards}` : "Cards: none",
    s.detail ? `Product detail shown: [${s.detail.id}] ${s.detail.title} — $${s.detail.price}` : "",
    s.suggestions.length ? `Suggestions: ${s.suggestions.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

async function simulate(openai: OpenAI, g: Goal, history: Array<{ role: "user" | "assistant"; content: string }>): Promise<Move> {
  const res = await openai.responses.create({
    model: MODEL, reasoning: { effort: "low" },
    // The shopper's own lines are "assistant" turns here: the simulator is the model; the shop talks to it.
    input: [{ role: "developer", content: SIM_INSTRUCTIONS(g) }, ...history],
    text: { format: zodTextFormat(Move, "move") },
  });
  return Move.parse(JSON.parse(res.output_text));
}

export type ConvRecord = {
  goalId: string; run: number; target: string; impossible: boolean;
  outcome: Move["outcome"] | "max_turns" | "error"; productIds: number[]; hard: boolean;
  success: boolean; turns: number; firstAcceptTurn: number | null; acceptShown: boolean;
  transcript: Array<{ user: string; screen: Screen }>; error?: string;
};

async function converse(openai: OpenAI, target: Target, g: Goal, run: number): Promise<ConvRecord> {
  const maxTurns = g.maxTurns ?? 8;
  const session = await target.start();
  const sim: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: "(The chat is open. Write your first message.)" }];
  const transcript: ConvRecord["transcript"] = [];
  const seen = new Set<number>();
  let firstAcceptTurn: number | null = null;
  // Each group must be covered by a picked product that was on screen; a plain goal is one group.
  const groups = g.acceptAll ?? [g.accept];
  const acceptable = new Set(groups.flat());
  const rec = (outcome: ConvRecord["outcome"], productIds: number[], error?: string): ConvRecord => {
    const picked = productIds.filter((id) => seen.has(id));
    const success = g.impossible ? outcome === "not_available"
      : outcome === "found" && groups.every((grp) => picked.some((id) => grp.includes(id)));
    return { goalId: g.id, run, target: target.name, impossible: g.impossible ?? false, hard: g.hard ?? false, outcome, productIds, success,
      turns: transcript.length, firstAcceptTurn, acceptShown: firstAcceptTurn !== null, transcript, ...(error ? { error } : {}) };
  };
  try {
    for (let turn = 1; turn <= maxTurns + 1; turn++) {
      const move = await simulate(openai, g, sim);
      if (move.outcome !== "continue") return rec(move.outcome, move.productIds);
      if (turn > maxTurns) return rec("max_turns", []);
      sim.push({ role: "assistant", content: move.message });
      const screen = await session.send(move.message);
      transcript.push({ user: move.message, screen });
      for (const c of [...screen.cards, ...(screen.detail ? [screen.detail] : [])]) {
        seen.add(c.id);
        if (firstAcceptTurn === null && acceptable.has(c.id)) firstAcceptTurn = turn;
      }
      sim.push({ role: "user", content: describe(screen) });
    }
    return rec("max_turns", []);
  } catch (err) {
    return rec("error", [],err instanceof Error ? err.message : String(err));
  }
}

// --- Targets -------------------------------------------------------------------------------------

async function pipelineTarget(openai: OpenAI): Promise<Target> {
  const S = "../src/";
  const [{ buildApp }, cache, { createTurnRunner }, { createReplyWriter }, { createDummyJsonApi }, { createRetriever },
    { createRouterClient }, { createSlotClient }, { openDatabase }, { createStore }, { createRateLimiter }] = await Promise.all([
    import(S + "app.ts"), import(S + "catalog/cache.ts"), import(S + "pipeline/runTurn.ts"), import(S + "reply/compose.ts"),
    import(S + "retrieval/dummyjson.ts"), import(S + "retrieval/port.ts"), import(S + "router/classify.ts"), import(S + "slots/extract.ts"),
    import(S + "store/db.ts"), import(S + "store/conversations.ts"), import(S + "web/rateLimit.ts"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "bazak-sim-eval-"));
  const { db, warning } = openDatabase(join(dir, "sim.sqlite"));
  const store = createStore(db, { warning });
  const catalog = createDummyJsonApi({ baseUrl: "https://dummyjson.com", cache: cache.createUrlCache({ ttlMs: 300_000, maxEntries: 200, now: Date.now }) });
  const runner = createTurnRunner({
    store, router: createRouterClient(openai), slots: createSlotClient(openai), retriever: createRetriever(catalog),
    categories: cache.createCategoryNames(catalog, { ttlMs: 3_600_000, now: Date.now }), catalog, writer: createReplyWriter(openai),
  });
  const app = buildApp({ store, runner, warning, limiter: createRateLimiter({ perConversation: Infinity, total: Infinity }) }, { logger: false });
  return {
    name: "pipeline",
    async start() {
      let convId: string | null = null;
      let revision = 0;
      return {
        async send(text) {
          const t0 = Date.now();
          const messageId = randomUUID();
          const res = await app.inject(convId
            ? { method: "POST", url: `/api/conversations/${convId}/messages`, payload: { messageId, text, revision } }
            : { method: "POST", url: "/api/conversations", payload: { messageId, text } });
          const body = res.json() as {
            conversationId?: string; revision?: number;
            assistantMessage?: { text: string; groups: Array<{ products: Array<Card & { stock?: number }> }>; suggestions?: Array<{ label: string }>; detail: (Card & { stock?: number }) | null };
          };
          if (body.conversationId) { convId = body.conversationId; revision = body.revision ?? revision; }
          const a = body.assistantMessage;
          if (!a) throw new Error(`HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
          const card = (p: Card & { stock?: number }): Card => ({ id: p.id, title: p.title, price: p.price, category: p.category, inStock: p.inStock ?? (p.stock ?? 1) > 0, rating: p.rating ?? null });
          return {
            reply: a.text, cards: a.groups.flatMap((g) => g.products.map(card)),
            suggestions: (a.suggestions ?? []).map((s) => s.label), detail: a.detail ? card(a.detail) : null, ms: Date.now() - t0,
          };
        },
      };
    },
    async close() { await app.close(); db.close(); },
  };
}

/** The yardstick: one model call per turn, the whole catalog and the chat so far in the prompt. */
function baselineTarget(openai: OpenAI): Target {
  type P = { id: number; title: string; category: string; brand?: string; price: number; rating: number; stock: number; tags: string[] };
  const products = JSON.parse(readFileSync(new URL("../test/fixtures/catalog.json", import.meta.url), "utf8")) as P[];
  const list = products.map((p) => `${p.id}|${p.title}|${p.category}|${p.brand ?? ""}|$${p.price}|${p.rating}|${p.stock}|${p.tags.join(",")}`).join("\n");
  const Out = z.object({ reply: z.string(), productIds: z.array(z.number().int()), detailId: z.number().int().nullable() });
  const SYSTEM = `You are the shopping assistant of a small online shop. You only sell what is in this catalog (id|title|category|brand|price USD|rating|stock|tags):
${list}

Reply in English, briefly. Show up to 4 matching products by id (best first) when the user is shopping; the user sees them as cards with title and price, so don't repeat every price. Respect price limits, stock, and gender. If the shop doesn't sell what they want, say so plainly and don't show unrelated products. Ask one short question only when the request is too open to pick products. Set detailId when the user asks about one specific product. You can't book, deliver, or track orders.`;
  const byId = new Map(products.map((p) => [p.id, p]));
  const card = (p: P): Card => ({ id: p.id, title: p.title, price: p.price, category: p.category, inStock: p.stock > 0, rating: p.rating });
  return {
    name: "baseline",
    async start() {
      const history: Array<{ role: "user" | "assistant"; content: string }> = [];
      return {
        async send(text) {
          const t0 = Date.now();
          history.push({ role: "user", content: text });
          const res = await openai.responses.create({
            model: MODEL, reasoning: { effort: "low" },
            input: [{ role: "developer", content: SYSTEM }, ...history], text: { format: zodTextFormat(Out, "turn") },
          });
          const out = Out.parse(JSON.parse(res.output_text));
          const cards = out.productIds.map((id) => byId.get(id)).filter((p): p is P => p !== undefined).slice(0, 4).map(card);
          const d = out.detailId === null ? undefined : byId.get(out.detailId);
          history.push({ role: "assistant", content: `${out.reply}\n[shown: ${cards.map((c) => `${c.id} ${c.title} $${c.price}`).join("; ") || "none"}]` });
          return { reply: out.reply, cards, suggestions: [], detail: d ? card(d) : null, ms: Date.now() - t0 };
        },
      };
    },
    async close() {},
  };
}

// --- Report --------------------------------------------------------------------------------------

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`);
const avg = (xs: number[]) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

export function renderSimReport(records: ConvRecord[], meta: { date: string; target: string; runs: number }): string {
  const possible = records.filter((r) => !r.impossible);
  const impossible = records.filter((r) => r.impossible);
  const ok = records.filter((r) => r.success);
  const lines = [
    "# Simulated-user eval report", "",
    `- Date: ${meta.date.slice(0, 16).replace("T", " ")} UTC`,
    `- Target: ${meta.target}; runs per goal: ${meta.runs}; conversations: ${records.length}`, "",
    "| Measure | Value |", "| --- | ---: |",
    `| task success (all goals) | **${pct(ok.length, records.length)}** |`,
    `| task success, standard goals / hard goals | ${pct(records.filter((r) => !r.hard && r.success).length, records.filter((r) => !r.hard).length)} / ${pct(records.filter((r) => r.hard && r.success).length, records.filter((r) => r.hard).length)} |`,
    `| found the right product (possible goals) | ${pct(possible.filter((r) => r.success).length, possible.length)} |`,
    `| right product was on screen at some point | ${pct(possible.filter((r) => r.acceptShown).length, possible.length)} |`,
    `| turns to success (mean, successful possible goals) | ${avg(possible.filter((r) => r.success).map((r) => r.turns)).toFixed(1)} |`,
    `| turn the right product first appeared (mean) | ${avg(possible.filter((r) => r.firstAcceptTurn !== null).map((r) => r.firstAcceptTurn as number)).toFixed(1)} |`,
    `| shopper gave up or ran out of turns | ${pct(records.filter((r) => r.outcome === "gave_up" || r.outcome === "max_turns").length, records.length)} |`,
    `| told "not available" for a product the shop has | ${possible.filter((r) => r.outcome === "not_available").length} |`,
    `| honest "we don't sell that" (impossible goals) | ${pct(impossible.filter((r) => r.success).length, impossible.length)} |`,
    `| errors | ${records.filter((r) => r.outcome === "error").length} |`,
    `| assistant turn latency p50 | ${(() => { const ms = records.flatMap((r) => r.transcript.map((t) => t.screen.ms)).sort((a, b) => a - b); return ms.length ? `${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s` : "n/a"; })()} |`,
    "", "## Per goal", "", "| Goal | Success | Outcomes | Turns |", "| --- | ---: | --- | --- |",
  ];
  for (const id of [...new Set(records.map((r) => r.goalId))]) {
    const rs = records.filter((r) => r.goalId === id);
    lines.push(`| ${id} | ${pct(rs.filter((r) => r.success).length, rs.length)} | ${rs.map((r) => r.outcome + (r.productIds.length ? `:${r.productIds.join("+")}` : "")).join(", ")} | ${rs.map((r) => r.turns).join(", ")} |`);
  }
  lines.push("", "## Failed conversations (first of each goal)", "");
  const seen = new Set<string>();
  for (const r of records) {
    if (r.success || seen.has(r.goalId)) continue;
    seen.add(r.goalId);
    lines.push(`### ${r.goalId} run ${r.run}: ${r.outcome}${r.productIds.length ? ` (picked ${r.productIds.join(", ")})` : ""}${r.error ? ` — ${r.error}` : ""}`, "");
    for (const [i, t] of r.transcript.entries()) {
      lines.push(`${i + 1}. **User:** ${t.user}`, `   **Bot:** ${t.screen.reply.replace(/\n+/g, " ")}`,
        `   Cards: ${t.screen.cards.map((c) => `[${c.id}] ${c.title} $${c.price}`).join(" · ") || "none"}${t.screen.detail ? ` · detail [${t.screen.detail.id}]` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// --- Main ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k as string, v ?? "true"]; }));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY is not set. Put it in server/.env, then run `npm run eval:sim` again."); process.exitCode = 1; return; }
  const openai = new OpenAI({ apiKey, maxRetries: 2 });
  const runs = Number(args.get("runs") ?? 3);
  const only = args.has("only") ? new Set((args.get("only") as string).split(",")) : null;
  const concurrency = Number(args.get("concurrency") ?? 4);
  const goals = (JSON.parse(readFileSync(new URL("goals.json", DIR), "utf8")) as Goal[]).filter((g) => only === null || only.has(g.id));
  const target = args.get("target") === "baseline" ? baselineTarget(openai) : await pipelineTarget(openai);

  const jobs = goals.flatMap((g) => Array.from({ length: runs }, (_, i) => ({ g, run: i + 1 })));
  console.log(`${target.name}: ${goals.length} goals × ${runs} runs = ${jobs.length} conversations`);
  const records: ConvRecord[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const { g, run } = jobs[next++]!;
      const r = await converse(openai, target, g, run);
      records.push(r);
      console.log(`${g.id} r${run} ${r.success ? "PASS" : "fail"} ${r.outcome}${r.productIds.length ? `:${r.productIds.join("+")}` : ""} in ${r.turns} turns${r.error ? ` (${r.error})` : ""}`);
    }
  }));
  await target.close();
  records.sort((a, b) => a.goalId.localeCompare(b.goalId) || a.run - b.run);

  const meta = { date: new Date().toISOString(), target: target.name, runs };
  const runsDir = new URL("runs/", DIR);
  mkdirSync(runsDir, { recursive: true });
  const payload = JSON.stringify({ meta, records }, null, 1);
  writeFileSync(new URL(`${meta.date.replace(/[:.]/g, "-")}-${target.name}.json`, runsDir), payload);
  writeFileSync(new URL(`latest-${target.name}.json`, runsDir), payload);
  writeFileSync(new URL(`report-${target.name}.md`, DIR), renderSimReport(records, meta));
  console.log(`Wrote eval/sim/report-${target.name}.md (success ${records.filter((r) => r.success).length}/${records.length})`);
}

if (import.meta.main) await main();
