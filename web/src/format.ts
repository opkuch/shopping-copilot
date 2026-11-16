const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatPrice = (price: number) => usd.format(price);

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
/** A bound the shopper set ("up to $1,351"): whole dollars print without cents. */
export const formatBound = (price: number) => (Number.isInteger(price) ? usdWhole.format(price) : usd.format(price));

export const formatRating = (rating: number) => rating.toFixed(1);

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "just now", "3 minutes ago", "yesterday". A date that does not parse yields "". */
export function formatRelative(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
