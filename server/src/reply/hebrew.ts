// Hebrew display names for group labels in a Hebrew conversation (the interface follows the conversation). Reviewed by hand; a noun
// or category missing here keeps its English label, which still reads fine as a product name.
import type { Slug } from "../messages/schema.ts";

export const CATEGORY_HE: Record<Slug, string> = {
  beauty: "יופי ואיפור",
  fragrances: "בשמים",
  furniture: "רהיטים",
  groceries: "מצרכים",
  "home-decoration": "עיצוב הבית",
  "kitchen-accessories": "אביזרי מטבח",
  laptops: "מחשבים ניידים",
  "mens-shirts": "חולצות גברים",
  "mens-shoes": "נעלי גברים",
  "mens-watches": "שעוני גברים",
  "mobile-accessories": "אביזרים לטלפון",
  motorcycle: "אופנועים",
  "skin-care": "טיפוח העור",
  smartphones: "טלפונים חכמים",
  "sports-accessories": "ציוד ספורט",
  sunglasses: "משקפי שמש",
  tablets: "טאבלטים",
  tops: "חולצות ושמלות",
  vehicle: "רכבים",
  "womens-bags": "תיקי נשים",
  "womens-dresses": "שמלות",
  "womens-jewellery": "תכשיטים",
  "womens-shoes": "נעלי נשים",
  "womens-watches": "שעוני נשים",
};

/** The product types people ask for most, as group labels. */
export const NOUN_HE: Record<string, string> = {
  earphone: "אוזניות", headphone: "אוזניות", earbud: "אוזניות", watch: "שעונים", dress: "שמלות", shoe: "נעליים",
  sneaker: "סניקרס", perfume: "בשמים", fragrance: "בשמים", laptop: "מחשבים ניידים", phone: "טלפונים",
  smartphone: "טלפונים", tablet: "טאבלטים", bag: "תיקים", handbag: "תיקים", backpack: "תרמילים", shirt: "חולצות",
  sunglass: "משקפי שמש", glass: "משקפיים", charger: "מטענים", case: "כיסויים", earring: "עגילים", ring: "טבעות",
  necklace: "שרשראות", jewelry: "תכשיטים", jewellery: "תכשיטים", lipstick: "שפתונים", mascara: "מסקרות",
  lotion: "קרמים", cream: "קרמים", moisturizer: "קרמי לחות", ball: "כדורים", basketball: "כדורסל",
  football: "כדורגל", racket: "מחבטים", bed: "מיטות", sofa: "ספות", chair: "כיסאות", table: "שולחנות",
  lamp: "מנורות", drink: "משקאות", juice: "מיצים", coffee: "קפה", speaker: "רמקולים", iphone: "אייפון",
  knife: "סכינים", pan: "מחבתות", cup: "כוסות", plate: "צלחות",
};

export const PURPOSE_HE = { gift: "רעיונות למתנה", curated: "מבחר" } as const;
