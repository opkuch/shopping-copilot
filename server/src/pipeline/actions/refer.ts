// Questions about the cards on screen. "Tell me about the second one": one product's live detail, and a
// reply that answers what was asked about it. "Which of these is best for running?", "compare them": the
// shown products' details, and a reply that answers from them, or says the listings don't say.
import type { ProductCard, ProductDetail } from "../../messages/schema.ts";
import * as T from "../../reply/templates.ts";
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
    brand: card.brand ?? null, availabilityStatus: null, warrantyInformation: null, shippingInformation: null,
    returnPolicy: null, reviewCount: null, source: "stored_card",
  };
}

/** The live detail; the stored card when that call fails. */
async function detailOf(t: Turn, card: ProductCard): Promise<ProductDetail> {
  try {
    return detailFromRaw(await t.deps.catalog.product(card.id, t.ctx));
  } catch (err) {
    if (!(err instanceof CallFailed)) throw err;
    t.trace.event("detail_stored_card", { id: card.id, ...{ kind: err.kind } });
    return detailFromCard(card);
  }
}

export async function referTurn(t: Turn, card: ProductCard): Promise<TurnOutcome> {
  t.setStage("searching");
  const detail = await detailOf(t, card);
  const unavailable = detail.source === "stored_card";
  t.summary.referCardId = card.id;

  t.setStage("writing");
  // With the detail missing there is nothing new for a model to phrase; the template says so.
  // The writer sees the category's display name, not its slug.
  const shownCategory = T.categoryName(detail.category, await t.loadNames());
  const prose = unavailable ? null : await t.deps.writer.write(
    { kind: "refer", detail: { ...detail, category: shownCategory }, message: t.text }, t.ctx,
  );
  return t.commit(prose ?? T.referText(detail.title, unavailable), { groups: [], detail });
}

/** The cards an answer reads: the ones on screen, at most this many (two searches of four). */
const MAX_ANSWERED = 8;

export async function answerTurn(t: Turn, shown: ProductCard[]): Promise<TurnOutcome> {
  t.summary.action = "answer";
  t.setStage("searching");
  // Product details are cached per id, so a second question about the same cards costs no fetch.
  const cards = shown.slice(-MAX_ANSWERED);
  const offset = shown.length - cards.length;
  const products = await Promise.all(cards.map(async (card, i) => ({ ...(await detailOf(t, card)), position: offset + i + 1 })));
  t.setStage("writing");
  const prose = await t.deps.writer.write({ kind: "answer", message: t.text, previous: t.lastExchange, products }, t.ctx);
  // No model answer: ask which card, so the next message can pick one and get its details.
  return t.commit(prose ?? T.referUnclear(shown.length), null);
}
