import type { Decision, DecisionCreateParams } from "openai/resources/decisions";
import { callWithRetry } from "../llm/call.ts";
import type { Act, Domain, RouterResult } from "../messages/schema.ts";
import { CallFailed } from "../pipeline/ports.ts";
import type { RouterClient, RouterInput } from "../pipeline/ports.ts";
import { MODEL } from "../llm/openai.ts";
import { turnContext } from "../prompts/context.ts";
import {
  ACT_CHOICES, CHAT_KIND_CHOICES, DOMAIN_CHOICES, QUESTIONS, REFER_UNCLEAR, ROUTER_INSTRUCTIONS,
  TARGET_GROUP_CHOICES, VERSION,
} from "../prompts/router.ts";

type Question = DecisionCreateParams["questions"][number];
type Choices = Record<string, string>;

function choiceQuestion(name: string, instructions: string, choices: Choices): Question {
  return {
    type: "choice",
    name,
    instructions,
    choices: Object.entries(choices).map(([value, description]) => ({ value, description })),
  };
}

export function buildQuestions(input: RouterInput): Question[] {
  const questions: Question[] = [
    choiceQuestion("act", QUESTIONS.act, ACT_CHOICES),
    choiceQuestion("domain", QUESTIONS.domain, DOMAIN_CHOICES),
    choiceQuestion("chat_kind", QUESTIONS.chat_kind, CHAT_KIND_CHOICES),
    { type: "predicate", name: "mentions_service", instructions: QUESTIONS.mentions_service },
  ];
  // Which search: one choice per search on screen, like the cards below, so it can't name one that isn't there.
  if (input.storedQueries.length >= 2) {
    const groups: Choices = {};
    input.storedQueries.forEach((q, i) => { groups[`group_${i + 1}`] = `${i + 1}. ${q.label}`; });
    questions.push(choiceQuestion("target_group", QUESTIONS.target_group, { ...groups, ...TARGET_GROUP_CHOICES }));
  }
  if (input.shownCards.length > 0) {
    const cards: Choices = {};
    for (const card of input.shownCards) {
      cards[`card_${card.index}`] = `${card.title} — ${card.category} — $${card.price}`;
    }
    questions.push(choiceQuestion("refer_target", QUESTIONS.refer_target, { ...cards, unclear: REFER_UNCLEAR }));
  }
  return questions;
}

// Stable instructions first (prompt caching), per-turn data last.
export function buildInput(input: RouterInput): DecisionCreateParams["input"] {
  return [
    { role: "developer", content: ROUTER_INSTRUCTIONS },
    {
      role: "user",
      content: [
        { type: "input_text", text: `Context:\n${turnContext(input)}` },
        { type: "input_text", text: `Latest message:\n${input.utterance}` },
      ],
    },
  ];
}

type Answer = Decision["answers"][number];
type RouterAnswers = RouterResult["answers"];

const ACTS: readonly string[] = ["chat", "refer", "refine", "new_search", "more", "reject", "remove"];
const DOMAINS: readonly string[] = ["catalog", "service", "off_topic"];
/**
 * Which search a change is for, below this confidence, is read as unclear (the turn then asks once). Measured
 * on router.v6: "make it cheaper" with two searches on screen came back "both" at 0.25-0.59 and was wrong 9
 * times out of 9.
 */
export const TARGET_GROUP_MIN_CONFIDENCE = 0.6;

export function parseDecision(decision: Decision, input: RouterInput): RouterResult {
  const byName = new Map<string, Answer>();
  for (const answer of decision.answers) if (answer.name) byName.set(answer.name, answer);

  const answers: RouterAnswers = {};
  let refused = false;
  // Returns the choice string, or null when missing, refused, or not one of `allowed`.
  // Only a type "refusal" answer is recorded as refused; an invalid value is malformed, not a refusal.
  const choice = (name: string, allowed: readonly string[]): string | null => {
    const answer = byName.get(name);
    if (!answer) return null;
    if (answer.type === "refusal") {
      answers[name] = { value: null, probability: null, refused: true };
      if (name === "act" || name === "domain") refused = true;
      return null;
    }
    const valid = answer.type === "choice" && typeof answer.choice === "string" && allowed.includes(answer.choice);
    answers[name] = {
      value: answer.type === "choice" ? String(answer.choice) : null,
      probability: answer.type === "choice" ? answer.confidence : null,
      refused: false,
    };
    return valid ? (answer as { choice: string }).choice : null;
  };

  const act = choice("act", ACTS);
  const domain = choice("domain", DOMAINS);
  const chatKind = choice("chat_kind", ["greeting", "catalog_overview", "other"]);
  // A missing or out-of-list act/domain is a malformed response, not a refusal: the caller must not store a refusal reply.
  for (const [name, value] of [["act", act], ["domain", domain]] as const) {
    if (value === null && !answers[name]?.refused) {
      throw new CallFailed("parse", `router returned a missing or invalid "${name}" answer`);
    }
  }

  let mentionsService = false;
  const service = byName.get("mentions_service");
  if (service?.type === "predicate") {
    mentionsService = service.probability >= 0.5;
    answers.mentions_service = { value: mentionsService, probability: service.probability, refused: false };
  } else if (service) {
    answers.mentions_service = { value: null, probability: null, refused: true };
  }

  let targetGroup: RouterResult["targetGroup"] = null;
  if (input.storedQueries.length >= 2) {
    const allowed = ["all", "unclear", ...input.storedQueries.map((_, i) => `group_${i + 1}`)];
    const group = choice("target_group", allowed);
    const sure = (answers.target_group?.probability ?? 0) >= TARGET_GROUP_MIN_CONFIDENCE;
    targetGroup = group === null || !sure || group === "unclear" ? "unclear" : group === "all" ? "all" : Number(group.slice(6));
  }

  let referTarget: RouterResult["referTarget"] = null;
  if (input.shownCards.length > 0) {
    const allowed = ["unclear", ...input.shownCards.map((c) => `card_${c.index}`)];
    const picked = choice("refer_target", allowed);
    referTarget = picked?.startsWith("card_") ? Number(picked.slice(5)) : "unclear";
  }

  return {
    refused,
    act: (act ?? "chat") as Act,
    domain: (domain ?? "off_topic") as Domain,
    chatKind: (chatKind ?? "greeting") as RouterResult["chatKind"],
    mentionsService,
    targetGroup,
    referTarget,
    answers,
  };
}

export type DecisionsClient = {
  decisions: {
    create(body: DecisionCreateParams, opts: { signal: AbortSignal; maxRetries: number; timeout: number }): Promise<Decision>;
  };
};

export function createRouterClient(client: DecisionsClient, opts: { timeoutMs?: number } = {}): RouterClient {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return {
    async route(input, ctx) {
      const body: DecisionCreateParams = { model: MODEL, input: buildInput(input), questions: buildQuestions(input) };
      const decision = await callWithRetry(
        (signal) =>
          client.decisions.create(body, { signal, maxRetries: 0, timeout: ctx.budget.timeoutFor(timeoutMs) }),
        { name: "router", timeoutMs, budget: ctx.budget, trace: ctx.trace, signal: ctx.signal },
      );
      const result = parseDecision(decision, input);
      ctx.trace.event("router", { prompt: VERSION, refused: result.refused, answers: result.answers });
      return result;
    },
  };
}
