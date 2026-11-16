// "Tell me about the second one": the live product detail, and a reply that answers what was asked about it.
import type { ProductCard, ProductDetail, Slug } from "../../messages/schema.ts";
import { CATEGORY_HE } from "../../reply/hebrew.ts";
import { categoryName } from "../../reply/templates.ts";
import { CallFailed } from "../ports.ts";
import type { RawProductFull, TurnOutcome } from "../ports.ts";
import type { Turn } from "../turn.ts";

function detailFromRaw(raw: RawProductFull): ProductDetail {
  return {
    id: raw.id, title: raw.title, description: raw.description, price: raw.price,
    thumbnail: raw.thumbnail, rating: raw.rating, category: raw.category, inStock: raw.stock > 0,
    brand: raw.brand ?? null,
    availabilityStatus: raw.availabilityStatus ?? null,
    warrantyInformation: raw.warrantyInformation ?? null,
    shippingInformation: raw.shippingInformation ?? null,
    returnPolicy: raw.returnPolicy ?? null,
    reviewCount: raw.reviews ? raw.reviews.length : null,
    source: "live",
  };
}

// The stored card has only a shortened description; the rest is honestly unknown.
function detailFromCard(card: ProductCard): ProductDetail {
  return {
    id: card.id, title: card.title, description: card.description, price: card.price,
    thumbnail: card.thumbnail, rating: card.rating, category: card.category, inStock: card.inStock,
    brand: null, availabilityStatus: null, warrantyInformation: null, shippingInformation: null,
    returnPolicy: null, reviewCount: null, source: "stored_card",
  };
}

/** Always the live detail; the stored card only when that call fails. */
export async function referTurn(t: Turn, card: ProductCard): Promise<TurnOutcome> {
  t.setStage("searching");
  let detail: ProductDetail;
  let unavailable = false;
  try {
    detail = detailFromRaw(await t.deps.catalog.product(card.id, t.ctx));
  } catch (err) {
    if (!(err instanceof CallFailed)) throw err;
    t.summary.fallbackPath = "detail_stored_card";
    detail = detailFromCard(card);
    unavailable = true;
  }
  t.summary.referCardId = card.id;

  t.setStage("writing");
  // With the detail missing there is nothing new for a model to phrase; the template says so.
  // The writer sees the category's display name, not its slug ("הקטגוריה היא fragrances").
  const shownCategory = t.language === "he"
    ? CATEGORY_HE[detail.category as Slug] ?? detail.category
    : categoryName(detail.category, await t.loadNames());
  const prose = unavailable ? null : await t.deps.writer.write(
    { kind: "refer", detail: { ...detail, category: shownCategory }, language: t.language, message: t.text }, t.ctx,
  );
  return t.commit(prose ?? t.L.referText(detail.title, unavailable), { groups: [], detail });
}
