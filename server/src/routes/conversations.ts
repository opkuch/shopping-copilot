import type { FastifyInstance, FastifyReply } from "fastify";
import { CreateConversationBody, SendMessageBody } from "../messages/schema.ts";
import type { ErrorCode } from "../messages/schema.ts";
import { createRateLimiter } from "../web/rateLimit.ts";
import type { RateLimiter } from "../web/rateLimit.ts";
import type { AcceptResult, Store, TurnRunner } from "../pipeline/ports.ts";

export type RouteDeps = { store: Store; runner: TurnRunner; warning: string | null; limiter?: RateLimiter };

type Accepted = { conversationId: string; revision: number; userMessage: { id: string; text: string; createdAt: string } };

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return reply.code(status).send({ error: { code, message }, ...extra });
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, runner } = deps;

  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return sendError(reply, 400, "validation", "Request could not be read as JSON of the expected shape.");
    }
    req.log.error({ err }, "unhandled error");
    // The default logger is off in tests and on in production; either way the client sees no internals.
    console.error("unhandled error:", err);
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong on the server." } });
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, "not_found", "No such route."));

  async function runAccepted(reply: FastifyReply, a: Accepted) {
    const outcome = await runner.run({ conversationId: a.conversationId, revision: a.revision, userMessage: a.userMessage });
    switch (outcome.kind) {
      case "completed":
        return reply.code(200).send(outcome.response);
      case "reply_failed":
        return sendError(reply, 503, "reply_failed", "The reply could not be produced. Send the same message again to retry.", {
          conversationId: outcome.conversationId,
          revision: outcome.revision,
          userMessageId: outcome.userMessageId,
          retryable: true,
        });
      case "dropped": {
        if (outcome.reason === "conversation_gone") return sendError(reply, 404, "not_found", "Conversation not found.");
        const conversation = store.getConversation(a.conversationId);
        if (!conversation) return sendError(reply, 404, "not_found", "Conversation not found.");
        return sendError(reply, 409, "revision_conflict", "The conversation changed; here is the current transcript.", { conversation });
      }
    }
  }

  async function handleAccept(reply: FastifyReply, accept: () => AcceptResult) {
    let result: AcceptResult;
    try {
      result = accept();
    } catch (err) {
      console.error("storage error while accepting message:", err);
      return sendError(reply, 500, "storage_failed", "Your message could not be saved. Nothing was stored.");
    }
    switch (result.kind) {
      case "not_found":
        return sendError(reply, 404, "not_found", "Conversation not found.");
      case "text_mismatch":
        return sendError(reply, 400, "validation", "This messageId was already used with different text.");
      case "conflict":
        return sendError(reply, 409, "revision_conflict", "The conversation changed; here is the current transcript.", {
          conversation: result.conversation,
        });
      case "accepted":
        return runAccepted(reply, result);
      case "exists": {
        const state = store.resendState(result.messageId);
        if (!state) return sendError(reply, 404, "not_found", "Conversation not found.");
        if (state.kind === "answered") {
          return reply.code(200).send({
            conversationId: state.conversationId,
            revision: state.revision,
            userMessage: { ...state.userMessage, role: "user" },
            assistantMessage: state.assistantMessage,
          });
        }
        if (state.kind === "not_tail") {
          return sendError(reply, 409, "revision_conflict", "That message is no longer the latest; here is the current transcript.", {
            conversation: state.conversation,
          });
        }
        return runAccepted(reply, state);
      }
    }
  }

  // New turns only: a resend of an accepted message joins its run and costs nothing. Checked before the
  // message is stored, so a refused message leaves no unanswered tail; the client puts the text back.
  const limiter = deps.limiter ?? createRateLimiter();
  const limited = (reply: FastifyReply, messageId: string, key: string) => {
    if (store.resendState(messageId) || limiter.allow(key)) return null;
    void reply.header("retry-after", String(limiter.retryAfter(key)));
    return sendError(reply, 429, "rate_limited", "Too many messages at once. Wait a moment and try again.");
  };

  const invalid = (reply: FastifyReply) =>
    sendError(reply, 400, "validation", "Send a non-blank message of at most 2000 characters with a UUID messageId.");

  app.post("/api/conversations", async (req, reply) => {
    const body = CreateConversationBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    const refused = limited(reply, body.data.messageId, "new");
    if (refused) return refused;
    return handleAccept(reply, () => store.acceptFirst(body.data.messageId, body.data.text));
  });

  app.get("/api/conversations", async () => {
    const { conversations } = store.listConversations();
    return { conversations, warning: deps.warning };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) return sendError(reply, 404, "not_found", "Conversation not found.");
    return conversation;
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req, reply) => {
    const body = SendMessageBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    const { messageId, text, revision } = body.data;
    const refused = limited(reply, messageId, req.params.id);
    if (refused) return refused;
    return handleAccept(reply, () => store.acceptMessage(req.params.id, messageId, text, revision));
  });

  app.get<{ Params: { messageId: string } }>("/api/messages/:messageId/progress", async (req) => ({
    stage: runner.stage(req.params.messageId),
    preview: runner.preview(req.params.messageId),
  }));

  app.get<{ Params: { messageId: string } }>("/api/messages/:messageId/trace", async (req, reply) => {
    const traces = store.traces(req.params.messageId);
    if (traces.length === 0 && !store.resendState(req.params.messageId)) {
      return sendError(reply, 404, "not_found", "No such message.");
    }
    return { traces };
  });
}
