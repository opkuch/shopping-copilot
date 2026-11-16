// Interface language: the interface follows the conversation. A Hebrew chat gets Hebrew
// labels and a right-to-left layout; the home page follows the browser's language until the first
// message. Product titles, prices and brands are catalog data and stay as they are.
import { createContext, useContext } from "react";

export type Lang = "en" | "he";

/** Any Hebrew letter means Hebrew, the same rule the server uses for replies (server/src/reply/language.ts). */
export const langOf = (text: string | undefined | null): Lang => (text && /[֐-׿]/.test(text) ? "he" : "en");

export const browserLang = (): Lang =>
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("he") ? "he" : "en";

const en = {
  appName: "Shopping copilot",
  newChat: "New chat",
  conversations: "Conversations",
  conversation: "Conversation",
  loadingConversations: "Loading conversations",
  loadingConversation: "Loading conversation",
  noConversations: "No conversations yet.",
  listFailed: "Couldn't load conversations.",
  conversationFailed: "Couldn't load this conversation.",
  historyUnreadable: "Earlier chat history couldn't be read and was set aside. New chats are saved normally.",
  retry: "Retry",
  message: "Message",
  placeholder: "Describe what you need",
  send: "Send",
  dismiss: "Dismiss",
  homeTitle: "What are you shopping for?",
  homeLead: "Find products in our catalog. Ask in your own words, with a budget if you have one.",
  tryAsking: "Try asking",
  starters: ["A dress under $50", "A smartphone with a good rating", "Something for my skin care routine"],
  stage: {
    idle: "Sending…",
    classifying: "Understanding your request…",
    searching: "Searching the catalog…",
    writing: "Writing a reply…",
  },
  noReplyYet: "No reply yet.",
  notSent: "Not sent.",
  suggested: "Suggested replies",
  outOfStock: "Out of stock",
  ratedOutOf5: (v: string) => `Rated ${v} out of 5`,
  reviews: (n: number) => `${n} ${n === 1 ? "review" : "reviews"}`,
  countOf: (shown: number, total: number) => (total > shown ? `${shown} of ${total}` : `${shown} ${shown === 1 ? "result" : "results"}`),
  rangeOf: (from: number, to: number, total: number) => `${from}–${to} of ${total}`,
  noMatches: "No matching products.",
  stillMatches: (label: string) => `${label}: the products above are still the matches.`,
  groupUnavailable: "Couldn't load these results right now.",
  resultsUnreadable: "Couldn't load these results.",
  messageFailed: "Couldn't display this message.",
  liveUnavailable: "Live details are unavailable right now; showing what we had.",
  fields: {
    brand: "Brand", availability: "Availability", warranty: "Warranty", shipping: "Shipping", returns: "Returns",
  },
  onlyLeft: (n: number) => `Only ${n} left`,
  /** What clicking a card sends: the same message the shopper could type. */
  tellMeAbout: (title: string) => `tell me about the ${title}`,
  off: (pct: number) => `${pct}% off`,
  remove: (what: string) => `Remove ${what}`,
  filters: "Applied filters",
  language: "Language",
  langAuto: "Auto (follows the chat)",
  upTo: (p: string) => `up to ${p}`,
  from: (p: string) => `from ${p}`,
  between: (a: string, b: string) => `${a}–${b}`,
  inStockOnly: "in stock",
  forMen: "for men",
  forWomen: "for women",
  anyPriceText: "any price",
  includeOutOfStockText: "include out of stock",
  toasts: {} as Record<string, string>,
};

export type Strings = typeof en;

const he: Strings = {
  appName: "עוזר קניות",
  newChat: "שיחה חדשה",
  conversations: "שיחות",
  conversation: "שיחה",
  loadingConversations: "טוען שיחות",
  loadingConversation: "טוען שיחה",
  noConversations: "אין עדיין שיחות.",
  listFailed: "לא הצלחתי לטעון את השיחות.",
  conversationFailed: "לא הצלחתי לטעון את השיחה הזו.",
  historyUnreadable: "לא ניתן היה לקרוא היסטוריית שיחות קודמת, והיא נשמרה בצד. שיחות חדשות נשמרות כרגיל.",
  retry: "נסו שוב",
  message: "הודעה",
  placeholder: "מה אתם מחפשים?",
  send: "שליחה",
  dismiss: "סגירה",
  homeTitle: "מה אתם מחפשים היום?",
  homeLead: "חפשו מוצרים בקטלוג שלנו. כתבו במילים שלכם, ואם יש תקציב, ציינו אותו.",
  tryAsking: "אפשר לנסות",
  starters: ["שמלה עד 50 דולר", "טלפון עם דירוג גבוה", "מתנה לאבא"],
  stage: {
    idle: "שולח…",
    classifying: "מבין את הבקשה…",
    searching: "מחפש בקטלוג…",
    writing: "כותב תשובה…",
  },
  noReplyYet: "עדיין אין תשובה.",
  notSent: "לא נשלח.",
  suggested: "תשובות מוצעות",
  outOfStock: "אזל מהמלאי",
  ratedOutOf5: (v) => `דירוג ${v} מתוך 5`,
  reviews: (n) => (n === 1 ? "ביקורת אחת" : `${n} ביקורות`),
  countOf: (shown, total) => (total > shown ? `${shown} מתוך ${total}` : shown === 1 ? "תוצאה אחת" : `${shown} תוצאות`),
  rangeOf: (from, to, total) => `${from}–${to} מתוך ${total}`,
  noMatches: "אין מוצרים מתאימים.",
  stillMatches: (label) => `${label}: המוצרים שלמעלה הם עדיין ההתאמות.`,
  groupUnavailable: "לא הצלחתי לטעון את התוצאות כרגע.",
  resultsUnreadable: "לא הצלחתי לטעון את התוצאות האלה.",
  messageFailed: "לא הצלחתי להציג את ההודעה הזו.",
  liveUnavailable: "פרטים עדכניים לא זמינים כרגע; מוצג מה שהיה שמור.",
  fields: {
    brand: "מותג", availability: "זמינות", warranty: "אחריות", shipping: "משלוח", returns: "החזרות",
  },
  onlyLeft: (n) => `נשארו רק ${n}`,
  tellMeAbout: (title) => `ספר לי על ${title}`,
  off: (pct) => `${pct}% הנחה`,
  remove: (what) => `הסרת ${what}`,
  filters: "סינונים פעילים",
  language: "שפה",
  langAuto: "אוטומטי (לפי השיחה)",
  upTo: (p) => `עד ${p}`,
  from: (p) => `מ-${p}`,
  between: (a, b) => `${a}–${b}`,
  inStockOnly: "במלאי",
  forMen: "לגברים",
  forWomen: "לנשים",
  anyPriceText: "בלי הגבלת מחיר",
  includeOutOfStockText: "גם מוצרים שאזלו מהמלאי",
  toasts: {
    "This chat changed in another tab. Your message wasn't sent.": "השיחה הזו השתנתה בלשונית אחרת. ההודעה לא נשלחה.",
    "Your message couldn't be saved. Nothing was sent.": "לא הצלחתי לשמור את ההודעה. שום דבר לא נשלח.",
    "Something went wrong.": "משהו השתבש.",
    "That conversation no longer exists.": "השיחה הזו כבר לא קיימת.",
    "Too many messages at once. Wait a moment and try again.": "יותר מדי הודעות בבת אחת. חכו רגע ונסו שוב.",
  },
};

export const STRINGS: Record<Lang, Strings> = { en, he };

/** The interface language chosen in the sidebar: "auto" follows the conversation. Kept per device. */
export type LangPref = "auto" | Lang;
const PREF_KEY = "bazak.uiLang";

export function readLangPref(): LangPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "en" || v === "he" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeLangPref(pref: LangPref): void {
  try {
    if (pref === "auto") localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, pref);
  } catch {
    // private mode or blocked storage: the choice lasts until reload
  }
}

export const LangContext = createContext<Lang>("en");

/** The interface strings for the current conversation's language. */
export const useT = (): Strings => STRINGS[useContext(LangContext)];
export const useLang = (): Lang => useContext(LangContext);
