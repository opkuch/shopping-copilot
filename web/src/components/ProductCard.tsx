import { useT } from "../i18n.ts";
import type { ProductCard as Card } from "../api/types.ts";
import { formatPrice, formatRating } from "../format.ts";
import { ProductImage } from "./ProductImage.tsx";

export function Rating({ rating, reviewCount = null }: { rating: number; reviewCount?: number | null }) {
  const t = useT();
  const value = formatRating(rating);
  return (
    <span className="rating">
      <span aria-hidden="true">★ {value}</span>
      <span className="visually-hidden">{t.ratedOutOf5(value)}</span>
      {reviewCount !== null && (
        <span className="muted">
          {" "}
          ({t.reviews(reviewCount)})
        </span>
      )}
    </span>
  );
}

export function OutOfStock() {
  return <span className="badge">{useT().outOfStock}</span>;
}

/**
 * `position` is the card's number in the search the chat is working on, the one "the second one" means.
 * `onOpen` makes the whole card a button that asks about it, the same message the shopper could type.
 */
export function ProductCard({ product, position = null, onOpen = null }: { product: Card; position?: number | null; onOpen?: ((title: string) => void) | null }) {
  const t = useT();
  const discount = product.discountPercentage ?? 0;
  return (
    <article className={onOpen ? "product-card openable" : "product-card"}>
      {position !== null && <span className="product-number">{position}</span>}
      <ProductImage src={product.thumbnail} alt={product.title} />
      <div className="product-body">
        {product.brand && <p className="product-brand">{product.brand}</p>}
        <h3 className="product-title" dir="auto">
          {onOpen ? (
            <button type="button" className="product-open" onClick={() => onOpen(product.title)}>
              {product.title}
            </button>
          ) : (
            product.title
          )}
        </h3>
        <p className="product-description" dir="auto">
          {product.description}
        </p>
        <div className="product-meta">
          <span className={product.inStock ? "price" : "price off"}>{formatPrice(product.price)}</span>
          <Rating rating={product.rating} />
        </div>
        <div className="product-badges">
          {!product.inStock && <OutOfStock />}
          {product.inStock && discount >= 5 && <span className="badge deal">{t.off(discount)}</span>}
          {product.stockLeft != null && <span className="badge low">{t.onlyLeft(product.stockLeft)}</span>}
        </div>
      </div>
    </article>
  );
}
