// Catalog enrichment (`npm run enrich:catalog`), offline, paid, opt-in; the output is committed and
// reviewed like code. Re-run when the catalog changes.
// One model pass writes src/catalog/enrichment.json: per product, whom it is for and the words a shopper
// might use for it that its title and tags don't say ("earbud" for AirPods, "drink" for Juice, "living
// room" for a sofa). Retrieval matches these like tags, in code.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { createOpenAIClient } from "../src/llm/openai.ts";
import { readResponse } from "../src/llm/openai.ts";

const MODEL = "gpt-6-luna";
const BATCH = 20;
const OUT = new URL("../src/catalog/enrichment.json", import.meta.url);

const Enriched = z.object({
  products: z.array(z.object({
    id: z.number().int(),
    gender: z.enum(["mens", "womens", "unisex", "none"]),
    keywords: z.array(z.string()),
  })),
});

const INSTRUCTIONS = `You prepare search keywords for a small online shop's catalog. For each product you get its id, title, brand, category, tags and description.
Return, for every product:
- keywords: 3 to 12 words or two-word phrases a shopper might type to find this exact product that its title and tags do not already contain. Include synonyms of the product type ("earbud", "earphone" for AirPods; "soccer ball" for a football; "sneaker", "trainer" for athletic shoes), its broader kind ("drink", "beverage" for juice; "footwear"; "ball"; "furniture"), and the sport, room, or use it is for ("tennis", "running", "living room", "bedroom", "kitchen", "office", "beach", "party", "workout", "travel"). English, lowercase, singular.
  Never include: colors, materials, sizes, brands, prices, subjective words (nice, best, luxury, cheap, premium, stylish), occasions or gifts (gift, birthday, wedding), gender or age words (men, women, kid). Only words that are true of this exact product; when unsure, leave the word out.
- gender: "womens" or "mens" only when the product is clearly made for one gender (a perfume sold as a women's fragrance, a men's lotion, a dress); "unisex" when it is marketed for everyone (for example "a classic unisex fragrance"); "none" for products where gender does not apply (food, electronics, furniture, sports balls).`;

type Raw = { id: number; title: string; brand?: string; category: string; tags?: string[]; description: string };

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = createOpenAIClient(apiKey);
  const res = await fetch("https://dummyjson.com/products?limit=0&select=id,title,brand,category,tags,description");
  const { products } = (await res.json()) as { products: Raw[] };
  await keywords(openai, products);
}

async function keywords(openai: ReturnType<typeof createOpenAIClient>, products: Raw[]): Promise<void> {
  console.log(`${products.length} products, batches of ${BATCH}`);

  const format = zodTextFormat(Enriched, "enriched");
  const batches: Raw[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));
  const results = await Promise.all(batches.map(async (batch, i) => {
    const input = batch.map((p) => ({ id: p.id, title: p.title, brand: p.brand ?? null, category: p.category, tags: p.tags ?? [], description: p.description }));
    const response = await openai.responses.create({
      model: MODEL, reasoning: { effort: "medium" }, text: { format },
      input: [{ role: "developer", content: INSTRUCTIONS }, { role: "user", content: JSON.stringify(input) }],
    });
    const parsed = Enriched.parse(JSON.parse(readResponse(response).text));
    console.log(`batch ${i + 1}/${batches.length}: ${parsed.products.length} products`);
    return parsed.products;
  }));

  const byId: Record<string, { gender: string; keywords: string[] }> = {};
  for (const p of results.flat()) {
    const keywords = [...new Set(p.keywords.map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0))];
    byId[String(p.id)] = { gender: p.gender, keywords };
  }
  const missing = products.filter((p) => byId[String(p.id)] === undefined).map((p) => p.id);
  if (missing.length > 0) console.warn(`no enrichment for ids: ${missing.join(", ")}`);
  const ordered = Object.fromEntries(Object.entries(byId).sort(([a], [b]) => Number(a) - Number(b)));
  writeFileSync(OUT, `${JSON.stringify({ generatedBy: "scripts/enrich-catalog.ts", model: MODEL, date: new Date().toISOString().slice(0, 10), products: ordered }, null, 1)}\n`);
  console.log(`wrote ${Object.keys(ordered).length} products to src/catalog/enrichment.json`);
}

await main();
