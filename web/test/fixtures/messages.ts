// Typed against the server schema: a contract change breaks the typecheck before it breaks a test.
import type { AssistantMessage, ConversationView, Group, ProductCard, ProductDetail, UserMessage } from "../../src/api/types.ts";

const at = "2026-11-14T10:00:00.000Z";

export const card = (over: Partial<ProductCard> = {}): ProductCard => ({
  id: 1,
  title: "Black Sun Glasses",
  description: "Classic black sunglasses with UV protection.",
  price: 29.99,
  thumbnail: "https://cdn.dummyjson.com/products/images/sunglasses/1/thumbnail.png",
  rating: 4.52,
  category: "sunglasses",
  inStock: true,
  ...over,
});

const query: Group["query"] = {
  category: "sunglasses", noun: null, attributes: [], priceMin: null, priceMax: null, sort: "price_asc", inStock: false, gender: null, categoryStated: true, top: false, within: null, purpose: null, exclude: [], offset: 0,
};

export const group = (over: Partial<Group> = {}): Group => ({
  label: "Sunglasses",
  status: "results",
  match: "exact",
  query,
  products: [card({ id: 1 }), card({ id: 2, title: "Party Glasses", price: 9.9 }), card({ id: 3 }), card({ id: 4 })],
  total: 23,
  ...over,
});

export const missGroup = (label = "Laptops"): Group => ({
  label, status: "miss", match: "none", query: { ...query, category: "laptops" }, products: [], total: 0,
});

export const unavailableGroup = (label = "Fragrances"): Group => ({
  label, status: "unavailable", match: "none", query: { ...query, category: "fragrances" }, products: [], total: 0,
});

export const detail = (over: Partial<ProductDetail> = {}): ProductDetail => ({
  id: 1,
  title: "Black Sun Glasses",
  description: "Classic black sunglasses with UV protection. The full description is longer than the card's.",
  price: 29.99,
  thumbnail: "https://cdn.dummyjson.com/products/images/sunglasses/1/thumbnail.png",
  rating: 4.52,
  category: "sunglasses",
  inStock: true,
  brand: "Ray-Ban",
  availabilityStatus: "In Stock",
  warrantyInformation: null,
  shippingInformation: "Ships in 1 week",
  returnPolicy: null,
  reviewCount: 3,
  source: "live",
  ...over,
});

export const assistant = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  text: "Here are 4 of 23 sunglasses, lowest price first.",
  suggestions: [],
  groups: [group()],
  detail: null,
  unreadable: false,
  createdAt: at,
  ...over,
});

export const user = (over: Partial<UserMessage> = {}): UserMessage => ({
  id: "u1", role: "user", text: "cheap sunglasses", createdAt: at, ...over,
});

export const conversation = (over: Partial<ConversationView> = {}): ConversationView => ({
  id: "c1", title: "cheap sunglasses", revision: 1, messages: [user(), assistant()], ...over,
});
