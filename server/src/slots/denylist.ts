// Subjective and purpose words. They are not keywords and never reach a query:
// the user judges "cool" from the cards, and we do not guess a category from "gift".
export const DENYLIST: ReadonlySet<string> = new Set([
  "cool", "nice", "pretty", "aesthetic", "awesome", "trendy", "stylish", "beautiful",
  "unique", "coolest", "best", "good", "great", "gift", "present",
]);
