import { CATEGORY_DESCRIPTIONS } from "../catalog/categories.ts";
import { SLUGS } from "../messages/schema.ts";

// Version history and the eval failures behind each change: README, "What I tried and abandoned".
export const VERSION = "extract.v12";

const SLUG_LINES = SLUGS.map((slug) => `- ${slug}: ${CATEGORY_DESCRIPTIONS[slug]}`).join("\n");

// Stable prefix: rules and the category list. Per-turn data follows it.
export const EXTRACT_INSTRUCTIONS = `You read one message sent to a shopping assistant and extract what the user wants to find, as structured data.
Return at most 2 intents, one per distinct product the user asks for. A request for an unnamed product that still carries a shopping constraint ("something cheap and cool", "anything under 20", "show me something in stock") is one intent with noun and category null and that constraint set. Return an empty list only when the message asks for nothing to buy (a greeting, thanks, a question about the store).
Only physical products become intents. A service (a flight, a hotel, a booking, a delivery, a repair) is never an intent and is not counted in droppedIntentCount: "headphones and a flight to Tokyo" is one intent (headphone); "book me a hotel and find me sunglasses" is one intent (sunglasses); "a flight to Tokyo" is no intent. Set droppedIntentCount to the number of further shoppable requests beyond the first two, otherwise 0.
You are given the previous exchange (the user's message before this one and the assistant's reply), the stored searches currently on screen, and the cards shown. When the message adjusts a shown search ("cheaper", "in red", "any price"), return one intent that holds only what the message changes. A product type the message names is always returned as the noun, also in a correction: "אהה בעצם אוזניות אפל" (oh actually, Apple headphones) is noun "headphone" with attributes ["apple"], never attributes ["apple"] alone. When the message only answers the assistant's question about which search to change ("the laptops", "the second one", "both"), return one intent with every field null and clear empty.
A request for someone ("a gift for my mom", "something for him") is one intent: put the recipient's gender in attributes as "men" or "women" (and "kid" for a child of any gender, with "men" or "women" too when the child is a boy or a girl), and leave the noun null unless a product is named.
A use names a kind of product: "something to drink" is noun "drink", "something to wear to work" is noun "clothing" or a garment, "something to read" is noun "book".
A request with no product named but a place, room, activity, or occasion ("something for the beach", "משהו לבית", "for a friend's wedding", "for the office", "surprise me") is one intent with noun and category null.

Each constraint belongs only to the product it modifies in the message. A price bound, sort, stock wish, or attribute written next to one product applies to that product's intent alone; every other intent gets null for it. Examples:
- "a laptop and a fragrance under 50": laptop priceMax null; fragrance priceMax 50.
- "cheap sunglasses and a laptop": sunglasses sort "price_asc"; laptop sort null.
- "a red dress and shoes": dress attributes ["red"]; shoes attributes null.
Copy a constraint to several intents only when the message says it covers them: "a laptop and a fragrance, both under 50", "under 50 each", "a laptop and a fragrance, all under 50", or a constraint stated before the list ("under 50: a laptop and a fragrance").

Rules for every intent field. null always means "the message does not mention it".
- noun: the thing being bought, one singular English head noun, correctly spelled, whatever language the message is in (for example "headphone", "charger", "watch"). Translate non-English words into English. A compound or sport-specific product name is the noun as one word: "basketball" (not noun "ball" with attribute "basketball"), "football" for a soccer ball ("כדורגל"), "earphone", "sneaker".
- attributes: singular English words that only narrow the noun ("red", "leather"). "phone case" is noun "case" with attributes ["phone"]. When the message changes the attributes of a stored search, return the full list wanted afterwards.
- Omit subjective and purpose words (cool, nice, best, good, gift, present, stylish, and similar). They are neither nouns nor attributes.
- Omit sizes and fits ("size M", "XL", "42", "size 9", "slim fit", "plus size"). The catalog has no sizes. They are neither nouns nor attributes.
- Gender words for whom the product is ("men's", "for women", "לנשים", "for my mom", "for him") go in attributes as "men" or "women".
- A brand ("Apple", "Nike", "Calvin Klein") goes in attributes as one item spelled as the brand is ("calvin klein"), never as the noun. A model or product-line name goes in attributes as one item with its brand when the user gives both ("Nike Air Jordan" is attributes ["nike air jordan"]; "Galaxy S10" is ["galaxy s10"]); never drop it. "Apple products" is attributes ["apple"] with noun null; "an Apple phone" is noun "phone" with attributes ["apple"].
- category: set only when the product clearly belongs to exactly one slug from the list below. Otherwise null. Never invent a slug.
- priceMin and priceMax: numbers from an explicit bound ("under 50" is priceMax 50; "between 20 and 40" is priceMin 20 and priceMax 40). Bounds are inclusive. No bound means null.
- currency: "USD" when the bound is in dollars or has no currency; "ILS" when it is in shekels (שקל, ש"ח, ₪, NIS); "other" for any other currency (euros, pounds); null when there is no bound. Copy the number as written; never convert it.
- relativePrice: "cheaper" or "pricier" when the user asks for cheaper or more expensive than what is shown. Do not also set a price bound for it.
- sort: "price_asc" for cheap, affordable, budget, or lowest price; "price_desc" for expensive, luxury, high-end, premium, fancy ("יוקרתי", "יקר"), or highest price; "rating" for best rated, "relevance" only when the user asks for default order. "Cheap" alone is a sort, not a price bound. Use relativePrice, not sort, for "cheaper" and "more expensive".
- inStock: true when the user wants only products in stock; otherwise null.
- The context's "conversation" says what the conversation is about ("a gift for a woman") and which kinds were rejected; read short messages against it. When the message turns down the products shown ("something else", "not earrings") without naming a new product, leave noun and category null and keep only what it states (a budget).
- gift: true when the message says gift or present ("מתנה"), names an occasion ("for my wife's birthday", "a friend's wedding"), or names someone close as the recipient ("for my dad", "לאשתי"); otherwise null. "And for a woman?" or "something for women" only changes who the product is for: gift null, attributes ["women"].
- theme: one lowercase English word or short phrase for the place, room, activity, or occasion the product is for, only when no product is named: "beach", "home", "housewarming", "kitchen", "office", "car", "travel", "sport", "wedding", "birthday", "valentine" (Valentine's Day, יום האהבה, ט"ו באב), "anniversary". Otherwise null. "Surprise me" or "recommend something" has no theme. A named sport or activity with gear is not a theme: "ציוד לטניס" (tennis gear) is attributes ["tennis"], theme null.
- clear: list a field only when the user explicitly removes that constraint ("any price", "any category", "include out of stock", "forget the color"). Never list a field because it was not mentioned. Fields: category, noun, attributes, price, sort, inStock.

Categories:
${SLUG_LINES}`;
