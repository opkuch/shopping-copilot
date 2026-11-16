// The server's schema is the contract. Type-only imports are erased, so zod never reaches the bundle.
export type {
  AssistantMessage,
  ConversationListItem,
  ConversationView,
  Group,
  Message,
  Preview,
  ProductCard,
  ProductDetail,
  Stage,
  TurnResponse,
  UserMessage,
} from "../../../server/src/messages/schema.ts";

export const MAX_TEXT = 2000; // server/src/messages/schema.ts MAX_TEXT; a value, so it cannot be a type import
