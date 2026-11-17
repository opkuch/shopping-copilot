import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Payload } from "../messages/schema.ts";
import type {
  AssistantMessage, ConversationListItem, ConversationView, Group, Message,
} from "../messages/schema.ts";
import type {
  AcceptResult, ResendState, Store, StoreAssistantResult,
} from "../pipeline/ports.ts";
import { withTransaction } from "./tx.ts";

type MsgRow = {
  id: string; conversation_id: string; role: "user" | "assistant"; position: number;
  text: string; payload_json: string | null; created_at: string;
};

const TITLE_MAX = 60;

function parsePayload(json: string): Payload | null {
  try {
    const r = Payload.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A trace row that can't be read is reported as such, like an unreadable message: the other traces still load. */
function parseTrace(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return { unreadable: true };
  }
}

function toMessage(row: MsgRow): Message {
  if (row.role === "user") {
    return { id: row.id, role: "user", text: row.text, createdAt: row.created_at };
  }
  const payload = row.payload_json === null ? { groups: [], detail: null } : parsePayload(row.payload_json);
  return {
    id: row.id, role: "assistant", text: row.text,
    groups: payload?.groups ?? [], detail: payload?.detail ?? null, suggestions: payload?.suggestions ?? [],
    unreadable: payload === null, createdAt: row.created_at,
  };
}

export function createStore(
  db: DatabaseSync,
  opts: { warning: string | null; now?: () => Date; newId?: () => string },
): Store {
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  const newId = opts.newId ?? randomUUID;

  const q = {
    msgById: db.prepare("SELECT * FROM messages WHERE id = ?"),
    convById: db.prepare("SELECT id, title, revision FROM conversations WHERE id = ?"),
    msgsOf: db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY position"),
    lastPos: db.prepare("SELECT MAX(position) AS p FROM messages WHERE conversation_id = ?"),
    lastOf: db.prepare("SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1"),
    insertConv: db.prepare("INSERT INTO conversations (id, title, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 0)"),
    insertMsg: db.prepare("INSERT INTO messages (id, conversation_id, role, position, text, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    bump: db.prepare("UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ?"),
    touch: db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?"),
    insertTrace: db.prepare("INSERT INTO turn_traces (id, user_message_id, attempt, outcome, trace_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    maxAttempt: db.prepare("SELECT MAX(attempt) AS a FROM turn_traces WHERE user_message_id = ?"),
    tracesOf: db.prepare("SELECT * FROM turn_traces WHERE user_message_id = ? ORDER BY attempt"),
    listIds: db.prepare("SELECT id FROM conversations ORDER BY updated_at DESC"),
    listRow: db.prepare("SELECT id, title, updated_at FROM conversations WHERE id = ?"),
    assistants: db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY position DESC"),
    lastThree: db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 3"),
  };

  function view(id: string): ConversationView | null {
    const c = q.convById.get(id) as { id: string; title: string; revision: number } | undefined;
    if (!c) return null;
    const rows = q.msgsOf.all(id) as MsgRow[];
    return { id: c.id, title: c.title, revision: c.revision, messages: rows.map(toMessage) };
  }

  function lastPosition(conversationId: string): number {
    return ((q.lastPos.get(conversationId) as { p: number | null }).p) ?? 0;
  }

  // Shared tail of both accept paths; runs inside the caller's transaction.
  function insertUser(conversationId: string, messageId: string, text: string, at: string): number {
    q.insertMsg.run(messageId, conversationId, "user", lastPosition(conversationId) + 1, text, null, at);
    q.bump.run(at, conversationId);
    return (q.convById.get(conversationId) as { revision: number }).revision;
  }

  function existing(messageId: string, text: string, conversationId: string | null): AcceptResult | null {
    const row = q.msgById.get(messageId) as MsgRow | undefined;
    if (!row) return null;
    if (row.text !== text || row.role !== "user" || (conversationId !== null && row.conversation_id !== conversationId)) {
      return { kind: "text_mismatch" };
    }
    return { kind: "exists", conversationId: row.conversation_id, messageId };
  }

  return {
    acceptFirst(messageId, text) {
      return withTransaction(db, (): AcceptResult => {
        const dup = existing(messageId, text, null);
        if (dup) return dup;
        const at = now();
        const id = newId();
        q.insertConv.run(id, text.trim().slice(0, TITLE_MAX), at, at);
        const revision = insertUser(id, messageId, text, at);
        return { kind: "accepted", conversationId: id, revision, userMessage: { id: messageId, text, createdAt: at } };
      });
    },

    acceptMessage(conversationId, messageId, text, revision) {
      return withTransaction(db, (): AcceptResult => {
        const dup = existing(messageId, text, conversationId);
        if (dup) return dup;
        const conv = q.convById.get(conversationId) as { revision: number } | undefined;
        if (!conv) return { kind: "not_found" };
        if (conv.revision !== revision) {
          return { kind: "conflict", conversation: view(conversationId) as ConversationView };
        }
        const at = now();
        const next = insertUser(conversationId, messageId, text, at);
        return { kind: "accepted", conversationId, revision: next, userMessage: { id: messageId, text, createdAt: at } };
      });
    },

    resendState(messageId) {
      const row = q.msgById.get(messageId) as MsgRow | undefined;
      if (!row || row.role !== "user") return null;
      const conv = q.convById.get(row.conversation_id) as { revision: number };
      const userMessage = { id: row.id, text: row.text, createdAt: row.created_at };
      const rows = q.msgsOf.all(row.conversation_id) as MsgRow[];
      const next = rows.find((r) => r.position === row.position + 1);
      if (next && next.role === "assistant") {
        return {
          kind: "answered", conversationId: row.conversation_id, revision: conv.revision, userMessage,
          assistantMessage: toMessage(next) as AssistantMessage,
        };
      }
      if (!next) {
        return { kind: "unanswered_tail", conversationId: row.conversation_id, revision: conv.revision, userMessage };
      }
      return { kind: "not_tail", conversation: view(row.conversation_id) as ConversationView } satisfies ResendState;
    },

    unansweredTail(conversationId) {
      const last = q.lastOf.get(conversationId) as { id: string; role: string } | undefined;
      return last?.role === "user" ? last.id : null;
    },

    storeAssistant({ conversationId, userMessageId, text, payload, trace }): StoreAssistantResult {
      return withTransaction(db, (): StoreAssistantResult => {
        if (!q.convById.get(conversationId)) return { kind: "dropped", reason: "conversation_gone" };
        const user = q.msgById.get(userMessageId) as MsgRow | undefined;
        if (!user || user.conversation_id !== conversationId || user.position !== lastPosition(conversationId)) {
          return { kind: "dropped", reason: "not_tail" };
        }
        const at = now();
        const id = newId();
        q.insertMsg.run(id, conversationId, "assistant", user.position + 1, text, payload ? JSON.stringify(payload) : null, at);
        q.insertTrace.run(newId(), userMessageId, trace.attempt, "completed", JSON.stringify(trace.trace ?? null), at);
        q.touch.run(at, conversationId);
        return {
          kind: "stored",
          assistantMessage: {
            id, role: "assistant", text, groups: payload?.groups ?? [], detail: payload?.detail ?? null,
            suggestions: payload?.suggestions ?? [],
            unreadable: false, createdAt: at,
          },
        };
      });
    },

    recordFailedTrace(userMessageId, attempt, outcome, trace) {
      try {
        withTransaction(db, () => {
          q.insertTrace.run(newId(), userMessageId, attempt, outcome, JSON.stringify(trace ?? null), now());
        });
      } catch (err) {
        console.error("failed to record trace", err);
      }
    },

    nextAttempt(userMessageId) {
      const r = q.maxAttempt.get(userMessageId) as { a: number | null };
      return (r.a ?? 0) + 1;
    },

    getConversation: view,

    listConversations() {
      const conversations: ConversationListItem[] = [];
      for (const { id } of q.listIds.all() as Array<{ id: string }>) {
        try {
          const r = q.listRow.get(id) as { id: string; title: string; updated_at: string };
          conversations.push({ id: r.id, title: r.title, updatedAt: r.updated_at });
        } catch {
          // One unreadable row must not hide the rest of the history.
        }
      }
      return { conversations, warning: opts.warning };
    },

    workingQuery(conversationId) {
      const rows = q.assistants.all(conversationId) as MsgRow[];
      for (const row of rows) {
        if (row.payload_json === null) continue;
        const payload = parsePayload(row.payload_json);
        if (payload === null) return null;
        if (payload.groups.length > 0) return { messageId: row.id, groups: payload.groups as Group[] };
      }
      return null;
    },

    shownCard(conversationId, productId) {
      // Newest first: the card as it was last shown (its stock and price may have changed since an older reply).
      const rows = (q.assistants.all(conversationId) as MsgRow[]);
      for (const row of rows) {
        const payload = row.payload_json === null ? null : parsePayload(row.payload_json);
        const card = payload?.groups.flatMap((g) => g.products).find((p) => p.id === productId);
        if (card) return card;
      }
      return null;
    },

    previousExchange(conversationId) {
      // The tail is the message being answered; the two before it are the last exchange.
      const [tail, assistant, user] = q.lastThree.all(conversationId) as MsgRow[];
      if (tail?.role !== "user" || assistant?.role !== "assistant" || user?.role !== "user") return null;
      const payload = assistant.payload_json === null ? null : parsePayload(assistant.payload_json);
      return { user: user.text, assistant: assistant.text, memory: payload?.memory ?? null, pending: payload?.pending ?? null };
    },

    traces(userMessageId) {
      const rows = q.tracesOf.all(userMessageId) as Array<{
        id: string; attempt: number; outcome: string; trace_json: string; created_at: string;
      }>;
      return rows.map((r) => ({
        id: r.id, attempt: r.attempt, outcome: r.outcome, trace: parseTrace(r.trace_json), createdAt: r.created_at,
      }));
    },
  };
}
