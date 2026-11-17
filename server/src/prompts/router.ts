// Version history and the eval failures behind each change: README, "What I tried and abandoned".
export const VERSION = "router.v10";

// Stable prefix: identical on every turn so prompt caching applies. Per-turn data follows it.
export const ROUTER_INSTRUCTIONS = `You classify one message sent to a shopping assistant for a small product catalog (laptops, phones, fragrances, furniture, groceries, clothing, watches, and similar goods).
You are given the user's latest message, the previous exchange (the user's message before it and the assistant's reply), the searches whose results are currently on screen (up to six, one per item of a shopping list), and the product cards currently shown, each with a 1-based index.
Answer each question about the latest message only. Use the previous exchange, the shown searches, and the cards only to resolve references such as "cheaper", "the second one", "the Rolex", or a short answer to a question the assistant just asked. Never answer from the catalog's contents; you cannot see them.
A product type on its own ("a handbag", "watches", "something for my car") asks to search, even when similar products are on screen; it refers to a shown card only when it names one specific card ("the black handbag").
A question whether the store has a brand or a kind of product ("do you sell Apple products?", "do you have running shoes?") asks to search for it; it is not a question about what the store sells in general.
A follow-up that only changes who the shown products are for, a price, a color, a brand, or stock ("and for a woman?", "and something up to 1200?", "only Nike", "not Apple") refines the shown search; it is not a new topic.
A shown card named by brand or model ("the Gucci", "the Longines", "the Dell"), or by a pronoun when one card is meant ("tell me about it"), refers to that card.
A question about the shown products that names no single card ("compare them", "which of these is best for running?", "is it waterproof?" with several shown, "what's the difference?") refers to the shown products; its card answer is unclear.
A question about a shown product's shipping, warranty, or returns refers to that product; it is not a request for a service.
A request for a gift, a recommendation, or something for a person, place, or occasion ("a gift for my dad", "surprise me", "recommend me something good", "something for the beach", "for a friend's wedding") asks to search, even though no product is named; it is a catalog request.
Turning down the kind of product shown without naming another ("something else", "not these", "not earrings"), even with a new budget ("something else up to $100"), rejects the shown products; it is not a refinement of them. Turning down only a brand, color, or feature of the shown products ("not Apple", "not leather") refines them. When the message names the product wanted instead ("not earrings, a watch"), it asks to search for that product.`;

export const QUESTIONS = {
  act:
    "What does the user's latest message ask the assistant to do with product search?",
  domain:
    "Is anything in the user's latest message a request for physical products, or is it a request for a service, or is it neither? If any part of the message is shoppable, choose catalog.",
  chat_kind:
    "If the user's latest message is not a product request, is it a greeting or thanks, a question about what the store sells, or something else?",
  mentions_service:
    "Does the user's latest message ask the assistant to provide or book a service the store cannot provide, such as a flight, a hotel, a delivery, or a repair, alongside or instead of products? A trip or event mentioned only as the reason for buying a product (\"headphones for my flight\", \"sunglasses for my holiday\") is not a request for a service.",
  target_group:
    "If the user wants to change, remove, or see other options for results already shown, which of the shown searches is it about? Match by the search's label (\"the sunscreen\", \"the laptops\") or its number in the list (\"#2\", \"the second item\"). If the assistant just asked which one to change, the latest message is the answer. A change meant for every search (\"make them all cheaper\") is all.",
  refer_target:
    "If the user is asking about one product already shown on screen, which shown card is it? Match by position (\"the second one\"), by name or description (\"the Rolex\", \"the Gucci\"), or by a pronoun when one card was just discussed. A question about several shown products, or about all of them, is unclear.",
} as const;

export const ACT_CHOICES: Record<"chat" | "refer" | "refine" | "new_search" | "more" | "reject" | "remove", string> = {
  chat: "A greeting, thanks, or a question about what the store sells. No product search is wanted.",
  refer: "The user asks about, compares, or wants details of products already shown on screen, without changing the search.",
  refine: "The user wants to change the results already shown: cheaper, pricier, a different color, in stock only, or another adjustment of the same search.",
  new_search: "The user asks for a product or topic different from what is on screen, asks for products when nothing is on screen, or asks for a gift, a recommendation, or something for a person, place, or occasion.",
  more: "The user asks to see more results of a search on screen, or other options for one item of a list, without changing it (\"show more\", \"what else is there?\", \"swap #2\", \"other options for the sunscreen\").",
  reject: "The user turns down the kind of product shown and wants a different kind, without naming it (\"something else\", \"not these\", \"not earrings\"), possibly with a new budget. Turning down only a brand or color of the shown products is refine.",
  remove: "The user takes one item off a list of several searches on screen (\"remove the eggs\", \"drop #3\", \"I don't need the mug\").",
};

export const DOMAIN_CHOICES: Record<"catalog" | "service" | "off_topic", string> = {
  catalog: "The message asks for a physical product, a gift, a recommendation, or something for a person, place, or occasion, or contains any shoppable request, even next to a non-product fragment.",
  service: "The message asks only for a service such as a flight, a hotel, a taxi, a booking, delivery, shipping, an order's status, or a return, and nothing in it is a product. A question about the shipping, warranty, or return policy of a product shown or named (\"how long does shipping take on the Dior?\") is about that product: catalog.",
  off_topic: "The message is neither shopping nor a service, such as a poem, a math question, or small talk about something else.",
};

export const CHAT_KIND_CHOICES: Record<"greeting" | "catalog_overview" | "other", string> = {
  greeting: "A greeting, thanks, or other pleasantry.",
  catalog_overview: "A question about what the store sells, which categories exist, or what the assistant can help with (\"what can you do?\").",
  other: "A request or question unrelated to shopping and to this assistant: a poem, math, the weather, the news, an order or a delivery.",
};

/** The fixed choices next to one per search on screen (built per turn in router/classify.ts). */
export const TARGET_GROUP_CHOICES: Record<"all" | "unclear", string> = {
  all: "Every search on screen, for example \"make them all cheaper\".",
  unclear: "The message does not say which search, or is not about the searches on screen.",
};

export const REFER_UNCLEAR = "The message does not point at one shown card, or is not about a shown product.";
