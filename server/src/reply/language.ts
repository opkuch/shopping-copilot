// The reply language, decided per turn in code: free, deterministic, and it still works when a
// model call fails. Hebrew is the requirement; anything else is answered in English.
export type Lang = "en" | "he";

const HEBREW = /[֐-׿]/;

export function detectLanguage(text: string): Lang {
  return HEBREW.test(text) ? "he" : "en";
}

export const LANGUAGE_NAME: Record<Lang, string> = { en: "English", he: "Hebrew" };
