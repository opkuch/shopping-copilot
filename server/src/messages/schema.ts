// Shared contract. Every module, test, and the future UI codes against these types.
// Changing a shape here changes the API: the web client imports these types (web/src/api/types.ts).
import { z } from "zod";

export const SLUGS = [
  "beauty", "fragrances", "furniture", "groceries", "home-decoration",
  "kitchen-accessories", "laptops", "mens-shirts", "mens-shoes", "mens-watches",
  "mobile-accessories", "motorcycle", "skin-care", "smartphones", "sports-accessories",
  "sunglasses", "tablets", "tops", "vehicle", "womens-bags", "womens-dresses",
  "womens-jewellery", "womens-shoes", "womens-watches",
] as const;
export const Slug = z.enum(SLUGS);
export type Slug = z.infer<typeof Slug>;

export const Sort = z.enum(["relevance", "price_asc", "price_desc", "rating"]);
export type Sort = z.infer<typeof Sort>;

// ---- Applied query (what retrieval actually ran; stored on each group) ----
export const Gender = z.enum(["mens", "womens"]);
export type Gender = z.infer<typeof Gender>;

export const Query = z.object({
  category: Slug.nullable(),
  noun: z.string().nullable(),
  /** Soft words (color, material, brand). Never gender words: those are `gender`. */
  attributes: z.array(z.string()),
  /** Whom the product is for. A selector over mens-/womens- categories, never relaxed, never printed. */
  gender: Gender.nullable().default(null),
  /** The user named the category (now or in the turn that set it), so the ladder never leaves it. */
  categoryStated: z.boolean().default(false),
  /** "Show more": how many of the sorted results are already behind the cards (0, 4, 8…). */
  offset: z.number().int().nonnegative().default(0),
  /** "The cheapest Samsung", "הכי מדורג": the winner is the first card and the reply names it. */
  top: z.boolean().default(false),
  /**
   * A browse limited to these categories: gift ideas for him, a curated "surprise me". Null: no such
   * limit. Chosen by code (pipeline/purpose.ts), never by the model.
   */
  within: z.array(Slug).nullable().default(null),
  /** Why the browse: labels the group ("Gift ideas") and the sentence. */
  purpose: z.enum(["gift", "curated"]).nullable().default(null),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  sort: Sort,
  inStock: z.boolean(),
});
export type Query = z.infer<typeof Query>;

export const ProductCard = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(), // <=160 chars, cut on a word boundary with "…"
  price: z.number(), // USD
  thumbnail: z.string(),
  rating: z.number(),
  category: z.string(),
  inStock: z.boolean(),
  /** Card extras added later; absent on cards stored before them. */
  brand: z.string().nullable().optional(),
  /** Whole percent, shown as a badge from 5% up. */
  discountPercentage: z.number().nullable().optional(),
  /** Units left, only when few (1-5): "only 3 left". */
  stockLeft: z.number().int().nullable().optional(),
});
export type ProductCard = z.infer<typeof ProductCard>;

export const GroupStatus = z.enum(["results", "miss", "unavailable"]);
// attributes_relaxed: the product type matched but the soft words (color, size, material) did not,
// so they were dropped and the reply says which.
export const Match = z.enum(["exact", "noun_outside_category", "attributes_relaxed", "category_fallback", "none"]);
export type Match = z.infer<typeof Match>;

export const Group = z.object({
  label: z.string(),
  status: GroupStatus,
  match: Match,
  query: Query,
  /** Four per page; "show more" appends, up to 12. */
  products: z.array(ProductCard).max(12),
  total: z.number().int().nonnegative(),
  /**
   * The cards are the ones already shown above, unchanged: a refine that found nothing keeps them as the
   * working query, and the client says so in one line instead of drawing the same cards twice.
   */
  repeat: z.boolean().optional(),
  /** "Show more": cards before this index are already shown in an earlier message; draw only the rest. */
  shownFrom: z.number().int().nonnegative().optional(),
});
export type Group = z.infer<typeof Group>;

export const ProductDetail = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(), // full text
  price: z.number(),
  thumbnail: z.string(),
  rating: z.number(),
  category: z.string(),
  inStock: z.boolean(),
  brand: z.string().nullable(),
  availabilityStatus: z.string().nullable(),
  warrantyInformation: z.string().nullable(),
  shippingInformation: z.string().nullable(),
  returnPolicy: z.string().nullable(),
  reviewCount: z.number().int().nullable(),
  source: z.enum(["live", "stored_card"]),
});
export type ProductDetail = z.infer<typeof ProductDetail>;

/** A tappable answer under a reply: the label is shown, the text is sent as the user's next message. */
export const Suggestion = z.object({ label: z.string().max(40), text: z.string().max(200) });
export type Suggestion = z.infer<typeof Suggestion>;

/**
 * Server-only: what a clarifying question already knows ("a gift, for him"), so the answer ("up to
 * $100") is read with it. Stored on the question's payload, used on the next turn only.
 */
export const PurposeContext = z.object({
  gift: z.boolean(),
  gender: Gender.nullable(),
  kid: z.boolean(),
  theme: z.string().nullable(),
});
export type PurposeContext = z.infer<typeof PurposeContext>;

/**
 * Server-only: what the conversation is about beyond the last exchange. Carried from reply to reply: the
 * purpose ("a gift, for her") until the shopper changes topic, and the kinds of product they rejected.
 */
export const ConversationMemory = z.object({
  purpose: PurposeContext.nullable(),
  excluded: z.array(Slug),
});
export type ConversationMemory = z.infer<typeof ConversationMemory>;

// Stored in messages.payload_json for assistant messages that carry groups or a detail.
export const Payload = z.object({
  groups: z.array(Group).max(2),
  detail: ProductDetail.nullable(),
  // Server-only: the change behind "Which one should I change?", applied when the next message
  // names a search ("the laptops"). Never sent to the client (AssistantMessage has no such field).
  pending: z.array(z.lazy(() => ExtractedIntent)).max(2).optional(),
  suggestions: z.array(Suggestion).max(8).optional(),
  purpose: PurposeContext.optional(),
  memory: ConversationMemory.optional(),
});
export type Payload = z.infer<typeof Payload>;

// ---- Messages as returned by the API ----
export const UserMessage = z.object({
  id: z.string(),
  role: z.literal("user"),
  text: z.string(),
  createdAt: z.string(),
});
export type UserMessage = z.infer<typeof UserMessage>;

export const AssistantMessage = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  text: z.string(),
  groups: z.array(Group).max(2),
  detail: ProductDetail.nullable(),
  /** Tappable answers ("Up to $50", "For him"); empty when the reply asks nothing. */
  suggestions: z.array(Suggestion).max(8).default([]),
  unreadable: z.boolean(),
  createdAt: z.string(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const Message = z.discriminatedUnion("role", [UserMessage, AssistantMessage]);
export type Message = z.infer<typeof Message>;

export const ConversationView = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int(),
  messages: z.array(Message),
});
export type ConversationView = z.infer<typeof ConversationView>;

export const ConversationListItem = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type ConversationListItem = z.infer<typeof ConversationListItem>;

// ---- Request bodies ----
export const MAX_TEXT = 2000;
const Text = z.string().max(MAX_TEXT).refine((s) => s.trim().length > 0, "text must not be blank");

export const CreateConversationBody = z.object({
  messageId: z.uuid(),
  text: Text,
});
export const SendMessageBody = z.object({
  messageId: z.uuid(),
  text: Text,
  revision: z.number().int().nonnegative(),
});

// ---- Turn response (HTTP 200) ----
export const TurnResponse = z.object({
  conversationId: z.string(),
  revision: z.number().int(),
  userMessage: UserMessage,
  assistantMessage: AssistantMessage,
});
export type TurnResponse = z.infer<typeof TurnResponse>;

// "internal" is an unexpected server error; unlike storage_failed it makes no claim about whether the message was saved.
export const ErrorCode = z.enum(["validation", "not_found", "revision_conflict", "storage_failed", "reply_failed", "internal", "rate_limited"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ---- Router (Decisions) result, already parsed and refusal-handled ----
export const Act = z.enum(["chat", "refer", "refine", "new_search", "more", "reject"]);
export type Act = z.infer<typeof Act>;
export const Domain = z.enum(["catalog", "service", "off_topic"]);
export type Domain = z.infer<typeof Domain>;
export const TargetGroup = z.enum(["first", "second", "both", "unclear"]);
export type TargetGroup = z.infer<typeof TargetGroup>;

export type RouterResult = {
  // "refused" means the model refused `act` or `domain`: the turn gets the refusal template.
  refused: boolean;
  act: Act;
  domain: Domain;
  chatKind: "greeting" | "catalog_overview" | "other";
  mentionsService: boolean;
  targetGroup: TargetGroup | null; // null when the question was not asked (fewer than two groups)
  referTarget: number | "unclear" | null; // 1-based flattened card index; null when not asked
  // name -> { value, probability } for every answered question, for the trace
  answers: Record<string, { value: string | boolean | null; probability: number | null; refused: boolean }>;
};

// ---- Extraction (Responses structured output) ----
export const ClearField = z.enum(["category", "noun", "attributes", "price", "sort", "inStock"]);
export type ClearField = z.infer<typeof ClearField>;

export const ExtractedIntent = z.object({
  category: Slug.nullable(),
  noun: z.string().nullable(),
  attributes: z.array(z.string()).nullable(),
  priceMin: z.number().nullable(),
  priceMax: z.number().nullable(),
  currency: z.enum(["USD", "ILS", "other"]).nullable(),
  /** Cheaper or pricier than the cards shown. */
  relativePrice: z.enum(["cheaper", "pricier"]).nullable(),
  sort: Sort.nullable(),
  inStock: z.boolean().nullable(),
  clear: z.array(ClearField),
  /** The user wants it as a gift ("מתנה לאבא", "for my wife's birthday"). */
  gift: z.boolean().nullable(),
  /** An occasion ("birthday", "valentine") or place ("beach") when no product is named. Occasions are gifts; a place gets one question. */
  theme: z.string().nullable(),
});
export type ExtractedIntent = z.infer<typeof ExtractedIntent>;

export const Extraction = z.object({
  intents: z.array(ExtractedIntent).max(2),
  droppedIntentCount: z.number().int(),
});
export type Extraction = z.infer<typeof Extraction>;

// "refused" is a successful call whose output is a refusal (not retryable).
export type ExtractionResult = { refused: true } | { refused: false; extraction: Extraction };

// ---- Progress ----
/**
 * What the turn has decided before the reply is written: the cards and the template sentence. Polled
 * through progress so the cards appear as soon as retrieval is done; the final message replaces it.
 */
export const Preview = z.object({ groups: z.array(Group).max(2), text: z.string() });
export type Preview = z.infer<typeof Preview>;

export const Stage = z.enum(["classifying", "searching", "writing", "idle"]);
export type Stage = z.infer<typeof Stage>;
