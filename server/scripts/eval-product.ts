// Product eval: what the user gets, end to end. Runs labelled queries and multi-turn dialogues through
// the real app (routes, store, orchestrator, retrieval, live models, live DummyJSON) on a throwaway
// database, scores the action, the cards, and the reply, asks a judge model for a rubric grade, and
// writes eval/product/report.md. Opt-in and paid.
//
//   npm run eval:product                      all sets except the holdout, 3 runs each
//   npm run eval:product -- --fast            1 run (quick check while building)
//   npm run eval:product -- --sets=holdout    the sealed holdout (run only at the final gates)
//   npm run eval:product -- --only=c07,d03 --no-judge
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  actionOf, mean, percentile, scoreTurn, scoreVague, timingsOf,
  type Action, type Card, type Dialogue, type Observed, type QueryCase, type TurnScore, type VagueCase,
} from "./product-metrics.ts";

const DIR = new URL("../eval/product/", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, DIR), "utf8")) as T;

type SetName = "queries" | "dialogues" | "vague" | "holdout";
type Step = { text: string; expect: Action; relevant: number[]; forbidden?: QueryCase["forbidden"]; detailId?: number; first?: number; vague?: VagueCase };
type Conversation = { set: SetName; id: string; author: string; steps: Step[] };

const Judgement = z.object({
  answers: z.number().int().min(1).max(5),
  accurate: z.number().int().min(1).max(5),
  honest: z.number().int().min(1).max(5),
  language: z.number().int().min(1).max(5),
  overall: z.number().int().min(1).max(5),
  reason: z.string(),
});
type Judgement = z.infer<typeof Judgement>;

export type TurnRecord = {
  key: string; set: SetName; caseId: string; author: string; turn: number; run: number;
  text: string; previous: { user: string; assistant: string } | null;
  expect: Action; observed: Omit<Observed, "cards"> & {
    cards: Array<Card & { thumbnail: string; rating?: number; inStock?: boolean }>;
    totals?: number[]; suggestions?: string[]; comparison?: Array<{ title: string; price: number; rating: number; inStock: boolean }> | null; detail: { id: number; title: string; price: number; thumbnail: string } | null };
  score: TurnScore | null; vague: { pass: boolean; reason: string } | null; judge: Judgement | null;
  /** Why the cards are what they are: the extractor's output and the retrieval ladder's steps. */
  why?: Array<{ kind: string; data: Record<string, unknown> }>;
};

const WHY_KINDS = new Set(["route", "router", "extract", "retrieval", "embed", "noun_multiword", "refine_kept_previous", "group_unavailable"]);

const JUDGE_INSTRUCTIONS = `You grade one turn of a shopping assistant for a small product catalog. You see the user's message, the previous exchange, the assistant's reply text, and the product cards shown under the reply (or a product detail, or nothing).
Grade each item from 1 (bad) to 5 (excellent):
- answers: does the turn respond to what the user actually asked or wanted? A question gets an answer; a request gets the matching products or an honest explanation.
- accurate: is the reply consistent with the cards shown (products, prices, counts)? Penalize any product or number that is not shown.
- honest: when something did not match, was dropped, or was not applied, does the reply say so plainly? A turn with nothing to disclose gets 5.
- language: is the reply in the user's language, natural and fluent? Product names may stay in English.
- overall: would a real shopper be satisfied with this turn, cards and reply together? Irrelevant cards (groceries for a gift, a luxury watch for "something for the home") lower this. A reply that describes how the search works ("I removed the word", "the search was widened", "results for <category>") instead of talking about products is worse than a plain one, even when it is accurate.
"totals" is how many products each search matched in all; the cards show at most a page of them. "suggestions" are tappable replies shown under the text.
The assistant only finds products in this shop's catalog. For a request outside that (a poem, math, the weather, an order's status, delivery, a booking), the right answer is a short, polite decline that says what it can do instead and offers a next step; grade such a reply on that, not on whether it did the unrelated task.
Judge only what you see. Be strict: 5 means nothing a careful shop assistant would do better. Give a one-sentence reason.`;

function conversations(sets: SetName[], only: Set<string> | null): Conversation[] {
  const out: Conversation[] = [];
  const keep = (id: string) => only === null || only.has(id);
  for (const set of sets) {
    if (set === "queries" || set === "holdout") {
      const file = set === "holdout" ? "sealed/holdout.json" : `${set}.json`;
      for (const q of read<QueryCase[]>(file)) {
        if (keep(q.id)) out.push({ set, id: q.id, author: q.author, steps: [{ text: q.text, expect: q.expect, relevant: q.relevant, forbidden: q.forbidden, first: q.first }] });
      }
    } else if (set === "dialogues") {
      for (const d of read<Dialogue[]>("dialogues.json")) {
        if (keep(d.id)) {
          out.push({
            set, id: d.id, author: d.author,
            steps: d.turns.map((t) => ({ text: t.text, expect: t.expect, relevant: t.relevant ?? [], forbidden: t.forbidden, detailId: t.detailId, first: t.first })),
          });
        }
      }
    } else {
      for (const v of read<VagueCase[]>("vague.json")) {
        if (keep(v.id)) out.push({ set, id: v.id, author: v.author, steps: [{ text: v.text, expect: v.expect === "clarify" ? "clarify" : "results", relevant: [], vague: v }] });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k as string, v ?? "true"];
  }));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set. Put it in server/.env, then run `npm run eval:product` again.");
    process.exitCode = 1;
    return;
  }
  const sets = (args.get("sets") ?? "queries,dialogues,vague").split(",") as SetName[];
  const runs = args.has("fast") ? 1 : Number(args.get("runs") ?? 3);
  const judgeOn = !args.has("no-judge");
  const only = args.has("only") ? new Set((args.get("only") as string).split(",")) : null;
  const concurrency = Number(args.get("concurrency") ?? 4);

  // Loaded here so importing this file never pulls in the app or the OpenAI client.
  const S = "../src/";
  const [{ buildApp }, cache, { createOpenAIClient }, { createTurnRunner }, { createReplyWriter }, { createDummyJsonApi },
    { createRetriever }, { createRouterClient }, { createSlotClient, readResponse }, { openDatabase }, { createStore },
    router, extract, prose, { zodTextFormat }] = await Promise.all([
    import(S + "app.ts"), import(S + "catalog/cache.ts"), import(S + "llm/openai.ts"), import(S + "pipeline/runTurn.ts"),
    import(S + "reply/compose.ts"), import(S + "retrieval/dummyjson.ts"), import(S + "retrieval/port.ts"),
    import(S + "router/classify.ts"), import(S + "slots/extract.ts"), import(S + "store/db.ts"), import(S + "store/conversations.ts"),
    import(S + "prompts/router.ts"), import(S + "prompts/extract.ts"), import(S + "prompts/prose.ts"),
    import("openai/helpers/zod"),
  ]);
  const { createRateLimiter } = await import(S + "web/rateLimit.ts");
  const unlimited = createRateLimiter({ perConversation: Infinity, total: Infinity });

  const openai = createOpenAIClient(apiKey);
  const catalogTitles = (JSON.parse(readFileSync(new URL("../test/fixtures/catalog.json", import.meta.url), "utf8")) as Array<{ title: string }>).map((p) => p.title);
  const JUDGE_FORMAT = zodTextFormat(Judgement, "judgement");

  async function judge(rec: TurnRecord): Promise<Judgement | null> {
    const facts = {
      previous: rec.previous, message: rec.text, reply: rec.observed.reply,
      // What the user sees on each card, so a true "rated 4.98" or "all in stock" is not marked unsupported.
      cards: rec.observed.cards.map((c) => ({ title: c.title, price: c.price, category: c.category, rating: c.rating, inStock: c.inStock })),
      totals: rec.observed.totals ?? [],
      detail: rec.observed.detail ? { title: rec.observed.detail.title, price: rec.observed.detail.price } : null,
      comparison: rec.observed.comparison ?? null,
      suggestions: rec.observed.suggestions ?? [],
    };
    try {
      const res = await openai.responses.create({
        model: "gpt-6-luna",
        input: [{ role: "developer", content: JUDGE_INSTRUCTIONS }, { role: "user", content: JSON.stringify(facts) }],
        reasoning: { effort: "low" }, text: { format: JUDGE_FORMAT },
      });
      const parsed = Judgement.safeParse(JSON.parse(readResponse(res).text));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      console.error(`judge failed for ${rec.key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  const records: TurnRecord[] = [];
  const convs = conversations(sets, only);
  console.log(`${convs.length} conversations, ${convs.reduce((n, c) => n + c.steps.length, 0)} turns, ${runs} run(s), judge ${judgeOn ? "on" : "off"}`);

  for (let run = 1; run <= runs; run++) {
    // A fresh app and database per run, so no run sees another's history or cache.
    const dir = mkdtempSync(join(tmpdir(), "bazak-product-eval-"));
    const { db, warning } = openDatabase(join(dir, "eval.sqlite"));
    const store = createStore(db, { warning });
    const catalog = createDummyJsonApi({ baseUrl: "https://dummyjson.com", cache: cache.createUrlCache({ ttlMs: 300_000, maxEntries: 200, now: Date.now }) });
    const runner = createTurnRunner({
      store, router: createRouterClient(openai), slots: createSlotClient(openai), retriever: createRetriever(catalog),
      categories: cache.createCategoryNames(catalog, { ttlMs: 3_600_000, now: Date.now }), catalog, writer: createReplyWriter(openai),
    });
    // The eval drives hundreds of turns a minute on purpose: no rate limit here.
    const app = buildApp({ store, runner, warning, limiter: unlimited }, { logger: false });

    let next = 0;
    async function worker(): Promise<void> {
      while (next < convs.length) {
        const conv = convs[next++] as Conversation;
        let convId: string | null = null;
        let revision = 0;
        let previous: TurnRecord["previous"] = null;
        let onScreen: Array<Card & { thumbnail?: string }> = [];
        // Everything the user has said in this conversation: a bound from an earlier message ("only up to
        // 2000") still applies and may be quoted.
        let said = "";
        for (const [i, step] of conv.steps.entries()) {
          const messageId = randomUUID();
          const res = await app.inject(convId
            ? { method: "POST", url: `/api/conversations/${convId}/messages`, payload: { messageId, text: step.text, revision } }
            : { method: "POST", url: "/api/conversations", payload: { messageId, text: step.text } });
          const body = res.json() as {
            conversationId?: string; revision?: number;
            assistantMessage?: { text: string; groups: Array<{ total: number; products: Array<Card & { thumbnail: string; rating: number; inStock: boolean }> }>;
            comparison?: Array<{ title: string; price: number; rating: number; inStock: boolean }> | null;
            suggestions?: Array<{ label: string; text: string }>; detail: { id: number; title: string; price: number; thumbnail: string } | null };
          };
          if (body.conversationId) { convId = body.conversationId; revision = body.revision ?? revision; }
          const trace = (store.traces(messageId).at(-1)?.trace ?? null) as Parameters<typeof actionOf>[1];
          const a = body.assistantMessage;
          const cards = (a?.groups ?? []).flatMap((g) => g.products.map((p) => ({ id: p.id, title: p.title, price: p.price, category: p.category, thumbnail: p.thumbnail, rating: p.rating, inStock: p.inStock })));
          const proseEvent = (trace?.events ?? []).find((e) => e.kind === "prose");
          const observed: TurnRecord["observed"] = {
            status: res.statusCode, action: actionOf(res.statusCode, trace, Boolean(a?.detail)),
            cards, groupCount: a?.groups.length ?? 0, detailId: a?.detail?.id ?? null,
            totals: (a?.groups ?? []).map((g) => g.total),
            suggestions: (a?.suggestions ?? []).map((x) => x.label),
            comparison: a?.comparison ? a.comparison.map((d) => ({ title: d.title, price: d.price, rating: d.rating, inStock: d.inStock })) : null,
            detail: a?.detail ? { id: a.detail.id, title: a.detail.title, price: a.detail.price, thumbnail: a.detail.thumbnail } : null,
            reply: a?.text ?? "", replyBy: trace?.reply === "model" || proseEvent?.data.outcome === "ok" ? "model" : a ? "template" : "none",
            ...timingsOf(trace),
          };
          const rec: TurnRecord = {
            key: `${conv.id}#${i + 1}#r${run}`, set: conv.set, caseId: conv.id, author: conv.author, turn: i + 1, run,
            text: step.text, previous, expect: step.expect, observed,
            score: step.vague ? null : scoreTurn({ action: step.expect, relevant: step.relevant, forbidden: step.forbidden, detailId: step.detailId, first: step.first }, observed, `${said} ${step.text}`, catalogTitles, observed.detail ? { id: observed.detail.id, title: observed.detail.title, price: observed.detail.price, category: "" } : null, onScreen),
            vague: step.vague ? scoreVague(step.vague, observed) : null,
            judge: null,
            why: (trace?.events ?? []).filter((e) => WHY_KINDS.has(e.kind)).map((e) => ({ kind: e.kind, data: e.data })),
          };
          if (judgeOn && observed.status === 200) rec.judge = await judge(rec);
          records.push(rec);
          const ok = rec.score?.pass ?? rec.vague?.pass;
          console.log(`run ${run} ${rec.key.padEnd(10)} ${ok ? "PASS" : "fail"}  ${observed.action.padEnd(9)} ${observed.totalMs ?? "-"}ms  ${step.text}`);
          previous = { user: step.text, assistant: observed.reply };
          said = `${said} ${step.text}`;
          // Everything this conversation has shown (cards and details) is a fact a reply may quote:
          // "nothing cheaper than the Realme C35 ($149.99)" after the C35 left the screen.
          onScreen = [...onScreen, ...cards, ...(observed.detail ? [{ ...observed.detail, category: "" }] : [])];
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    await app.close();
    db.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runsDir = new URL("runs/", DIR);
  mkdirSync(runsDir, { recursive: true });
  const meta = {
    date: new Date().toISOString(), sets, runs, judge: judgeOn,
    promptVersions: { router: router.VERSION, extract: extract.VERSION, prose: prose.VERSION },
  };
  const payload = JSON.stringify({ meta, records }, null, 1);
  writeFileSync(new URL(`${stamp}.json`, runsDir), payload);
  writeFileSync(new URL("latest.json", runsDir), payload);
  const grades = (() => { try { return read<Grade[]>("grades.json"); } catch { return []; } })();
  const reportName = sets.length === 1 && sets[0] === "holdout" ? "report-holdout.md" : "report.md";
  writeFileSync(new URL(reportName, DIR), renderProductReport(records, meta, grades));
  console.log(`Wrote eval/product/${reportName} and runs/${stamp}.json`);
}

export type Grade = { key: string; text: string; reply: string; score: number; note?: string };

const pct = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(0)}%`);
const num = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const ms = (x: number | null) => (x === null ? "n/a" : `${(x / 1000).toFixed(1)} s`);

export function renderProductReport(records: TurnRecord[], meta: { date: string; sets: string[]; runs: number; judge: boolean; promptVersions: Record<string, string> }, grades: Grade[]): string {
  const scored = records.filter((r) => r.score !== null);
  const s = scored.map((r) => r.score as TurnScore);
  const precision = mean(s.map((x) => x.precision).filter((x): x is number => x !== null));
  const recall = mean(s.map((x) => x.recall).filter((x): x is number => x !== null));
  const actionAcc = s.length === 0 ? null : s.filter((x) => x.actionOk).length / s.length;
  const forbidden = s.reduce((n, x) => n + x.forbiddenCards, 0);
  const deadEnds = s.filter((x) => x.deadEnd).length;
  const invented = s.reduce((n, x) => n + x.inventedPrices + x.inventedTitles, 0);
  const vague = records.filter((r) => r.vague !== null);
  const vaguePass = vague.length === 0 ? null : vague.filter((r) => r.vague?.pass).length / vague.length;
  const judged = records.filter((r) => r.judge !== null).map((r) => r.judge as Judgement);
  const jm = (k: keyof Omit<Judgement, "reason">) => mean(judged.map((j) => j[k]));
  const product = records.filter((r) => r.observed.cardsMs !== null);
  const cardsMs = product.map((r) => r.observed.cardsMs as number);
  const totalMs = product.map((r) => r.observed.totalMs).filter((x): x is number => x !== null);
  const writerMs = records.map((r) => r.observed.writerMs).filter((x): x is number => x !== null);
  const passRate = (rs: TurnRecord[]) => rs.filter((r) => r.score?.pass ?? r.vague?.pass).length / Math.max(1, rs.length);

  const target = (ok: boolean | null) => (ok === null ? "–" : ok ? "✅" : "❌");
  const lines = [
    "# Product eval report",
    "",
    `- Date: ${meta.date.slice(0, 16).replace("T", " ")} UTC`,
    `- Prompts: ${Object.entries(meta.promptVersions).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `- Sets: ${meta.sets.join(", ")}; runs: ${meta.runs}; turns scored: ${records.length}; judge: ${meta.judge ? "on" : "off"}`,
    `- Turn pass rate (right action, precision ≥ 0.75 and recall ≥ 0.5 where labelled, no forbidden card, nothing invented): **${pct(passRate(records))}**`,
    "",
    "## Scorecard against the A- targets",
    "",
    "| Measure | Value | A- target | |",
    "| --- | ---: | ---: | :-: |",
    `| precision@shown (labelled turns) | ${num(precision)} | ≥ 0.85 | ${target(precision === null ? null : precision >= 0.85)} |`,
    `| recall@shown (labelled turns) | ${num(recall)} | ≥ 0.80 | ${target(recall === null ? null : recall >= 0.8)} |`,
    `| forbidden cards shown | ${forbidden} | 0 | ${target(forbidden === 0)} |`,
    `| right action | ${pct(actionAcc)} | ≥ 95% | ${target(actionAcc === null ? null : actionAcc >= 0.95)} |`,
    `| dead ends ("which one?" when an action was obvious) | ${deadEnds} | 0 | ${target(deadEnds === 0)} |`,
    `| invented prices or titles in replies | ${invented} | 0 | ${target(invented === 0)} |`,
    `| vague requests handled (clarify or coherent) | ${pct(vaguePass)} | 100% | ${target(vaguePass === null ? null : vaguePass === 1)} |`,
    `| judge: overall (1–5) | ${num(jm("overall"))} | ≥ 4.3 | ${target(jm("overall") === null ? null : (jm("overall") as number) >= 4.3)} |`,
    `| time to cards p50 / p90 | ${ms(percentile(cardsMs, 0.5))} / ${ms(percentile(cardsMs, 0.9))} | ≤ 2.5 s / 3.5 s | ${target(cardsMs.length === 0 ? null : (percentile(cardsMs, 0.5) as number) <= 2500 && (percentile(cardsMs, 0.9) as number) <= 3500)} |`,
    `| full reply p50 / p90 | ${ms(percentile(totalMs, 0.5))} / ${ms(percentile(totalMs, 0.9))} | p50 ≤ 4 s | ${target(totalMs.length === 0 ? null : (percentile(totalMs, 0.5) as number) <= 4000)} |`,
    "",
    `Judge detail (mean 1–5): answers ${num(jm("answers"))}, accurate ${num(jm("accurate"))}, honest ${num(jm("honest"))}, language ${num(jm("language"))}, overall ${num(jm("overall"))}. Reply writer p50 ${ms(percentile(writerMs, 0.5))}. "Time to cards" is when retrieval finished; today the cards are only sent with the full reply.`,
    "",
  ];

  // Judge calibration against your hand grades.
  const byKey = new Map(records.map((r) => [r.key, r]));
  const paired = grades.map((g) => ({ g, r: byKey.get(g.key) })).filter((x) => x.r?.judge && x.r.observed.reply === x.g.reply);
  lines.push("## Judge calibration", "");
  if (paired.length === 0) lines.push("No hand grades match this run yet. Grade replies in the labelling page (Grade tab), then rerun.", "");
  else {
    const diffs = paired.map(({ g, r }) => Math.abs(g.score - (r?.judge?.overall ?? 0)));
    lines.push(`${paired.length} turns graded by you. Mean absolute difference from the judge: **${num(mean(diffs))}**; within ±1: **${pct(diffs.filter((d) => d <= 1).length / diffs.length)}**. Trust the judge's mean only if within ±1 is at least 80%.`, "");
  }

  for (const set of ["queries", "dialogues", "vague", "holdout", "qa"] as const) {
    const rs = records.filter((r) => r.set === set);
    if (rs.length === 0) continue;
    lines.push(`## ${set}`, "", "| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |", "| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |");
    const keys = [...new Set(rs.map((r) => `${r.caseId}#${r.turn}`))];
    for (const k of keys) {
      const group = rs.filter((r) => `${r.caseId}#${r.turn}` === k);
      const first = group[0] as TurnRecord;
      const p = mean(group.map((r) => r.score?.precision).filter((x): x is number => typeof x === "number"));
      const rc = mean(group.map((r) => r.score?.recall).filter((x): x is number => typeof x === "number"));
      const jo = mean(group.map((r) => r.judge?.overall).filter((x): x is number => typeof x === "number"));
      lines.push(`| ${first.caseId}${first.author === "claude" ? "" : " ✍"} | ${first.turn} | ${first.text.replace(/\|/g, "/")} | ${first.expect} | ${group.map((r) => r.observed.action).join(", ")} | ${num(p)} | ${num(rc)} | ${num(jo, 1)} | ${pct(passRate(group))} |`);
    }
    lines.push("");
  }

  lines.push("## Failures (first run of each)", "");
  const seen = new Set<string>();
  for (const r of records) {
    const ok = r.score?.pass ?? r.vague?.pass;
    const k = `${r.caseId}#${r.turn}`;
    if (ok || seen.has(k)) continue;
    seen.add(k);
    const why: string[] = [];
    if (r.score) {
      if (!r.score.actionOk) why.push(`action ${r.observed.action} (expected ${r.expect})`);
      if (r.score.precision !== null && r.score.precision < 0.75) why.push(`precision ${num(r.score.precision)}`);
      if (r.score.recall !== null && r.score.recall < 0.5) why.push(`recall ${num(r.score.recall)}`);
      if (r.score.forbiddenCards) why.push(`${r.score.forbiddenCards} forbidden card(s)`);
      if (r.score.inventedPrices || r.score.inventedTitles) why.push("invented price/title");
    }
    if (r.vague && !r.vague.pass) why.push(r.vague.reason);
    lines.push(`- **${k}** "${r.text}": ${why.join("; ")}`, `  - reply: ${r.observed.reply.replace(/\n/g, " ")}`, `  - cards: ${r.observed.cards.map((c) => `${c.title} $${c.price}`).join(" · ") || "none"}`);
  }
  if (seen.size === 0) lines.push("None.");
  return lines.join("\n") + "\n";
}

if (import.meta.main) await main();

