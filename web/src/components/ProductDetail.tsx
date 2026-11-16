import { useT } from "../i18n.ts";
import type { Strings } from "../i18n.ts";
import type { ProductDetail as Detail } from "../api/types.ts";
import { formatPrice } from "../format.ts";
import { OutOfStock, Rating } from "./ProductCard.tsx";
import { ProductImage } from "./ProductImage.tsx";

const FIELDS: Array<[keyof Detail, keyof Strings["fields"]]> = [
  ["brand", "brand"],
  ["availabilityStatus", "availability"],
  ["warrantyInformation", "warranty"],
  ["shippingInformation", "shipping"],
  ["returnPolicy", "returns"],
];

export function ProductDetail({ detail }: { detail: Detail }) {
  const t = useT();
  const facts = FIELDS.flatMap(([key, field]) => {
    const value = detail[key];
    return typeof value === "string" && value.trim() !== "" ? [{ label: t.fields[field], value }] : [];
  });
  return (
    <article className="product-detail" aria-label={detail.title}>
      <ProductImage src={detail.thumbnail} alt={detail.title} />
      <div className="product-body">
        <h2 className="product-title" dir="auto">
          {detail.title}
        </h2>
        <div className="product-meta">
          <span className={detail.inStock ? "price" : "price off"}>{formatPrice(detail.price)}</span>
          <Rating rating={detail.rating} reviewCount={detail.reviewCount} />
        </div>
        {!detail.inStock && <OutOfStock />}
        <p className="detail-description" dir="auto">
          {detail.description}
        </p>
        {facts.length > 0 && (
          <dl className="detail-facts">
            {facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd dir="auto">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {detail.source === "stored_card" && (
          <p className="muted detail-note">{t.liveUnavailable}</p>
        )}
      </div>
    </article>
  );
}
