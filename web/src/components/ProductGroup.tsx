import { useT } from "../i18n.ts";
import type { Strings } from "../i18n.ts";
import { formatBound } from "../format.ts";
import type { Group } from "../api/types.ts";
import { ProductCard } from "./ProductCard.tsx";

// `match` is deliberately not rendered: the sentence above explains a fallback, and a second
// explanation here would be a second source of truth.
type Filter = { key: string; label: string; clear: string | null };

/** What the search is applying, as chips; price and stock can be removed in one tap (a message). */
function filtersOf(group: Group, t: Strings): Filter[] {
  const q = group.query;
  const out: Filter[] = [];
  if (q.priceMin !== null && q.priceMax !== null) out.push({ key: "price", label: t.between(formatBound(q.priceMin), formatBound(q.priceMax)), clear: t.anyPriceText });
  else if (q.priceMax !== null) out.push({ key: "price", label: t.upTo(formatBound(q.priceMax)), clear: t.anyPriceText });
  else if (q.priceMin !== null) out.push({ key: "price", label: t.from(formatBound(q.priceMin)), clear: t.anyPriceText });
  if (q.inStock) out.push({ key: "stock", label: t.inStockOnly, clear: t.includeOutOfStockText });
  if (q.gender) out.push({ key: "gender", label: q.gender === "mens" ? t.forMen : t.forWomen, clear: null });
  for (const a of q.attributes) out.push({ key: `attr-${a}`, label: a, clear: null });
  return out;
}

type GroupProps = {
  group: Group;
  onRefine?: ((text: string) => void) | null;
  /** The number of this group's first card in the working search, or null to show no numbers. */
  firstPosition?: number | null;
  onOpen?: ((title: string) => void) | null;
};

export function ProductGroup({ group, onRefine = null, firstPosition = null, onOpen = null }: GroupProps) {
  const t = useT();
  const filters = group.status === "unavailable" ? [] : filtersOf(group, t);
  // Cards already drawn in an earlier message are not drawn again: a kept group is one line, and
  // "show more" draws only the cards it added (the reply says which ones).
  // A kept group that had no cards has nothing "above" to point at; the reply already says so.
  if (group.repeat && group.products.length === 0) return null;
  if (group.repeat) {
    return (
      <section className="product-group repeat" aria-label={group.label}>
        <p className="group-note muted" dir="auto">
          {t.stillMatches(group.label)}
        </p>
      </section>
    );
  }
  const from = group.shownFrom ?? 0;
  const drawn = group.products.slice(from);
  return (
    <section className={`product-group ${group.status}`} aria-label={group.label}>
      <header className="group-header">
        <h2 dir="auto">{group.label}</h2>
        {group.status === "results" && (
          <span className="muted">{from > 0 ? t.rangeOf(from + 1, group.products.length, group.total) : t.countOf(group.products.length, group.total)}</span>
        )}
      </header>
      {filters.length > 0 && (
        <ul className="filters" aria-label={t.filters}>
          {filters.map((f) => (
            <li key={f.key} className="filter" dir="auto">
              <span>{f.label}</span>
              {f.clear !== null && onRefine !== null && (
                <button type="button" className="filter-clear" aria-label={t.remove(f.label)} onClick={() => onRefine(f.clear as string)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {group.status === "results" && (
        <div className="product-grid">
          {drawn.map((p, i) => (
            <ProductCard key={p.id} product={p} position={firstPosition === null ? null : firstPosition + from + i} onOpen={onOpen} />
          ))}
        </div>
      )}
      {group.status === "miss" && <p className="group-note muted">{t.noMatches}</p>}
      {group.status === "unavailable" && (
        <p className="group-note warning" role="note">
          {t.groupUnavailable}
        </p>
      )}
    </section>
  );
}
