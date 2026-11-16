import { resolve } from "node:path";
import { checkStartup, listenOptions } from "./boot.ts";
import { buildApp } from "./app.ts";
import { createCategoryNames, createUrlCache } from "./catalog/cache.ts";
import { createOpenAIClient } from "./llm/openai.ts";
import { createTurnRunner } from "./pipeline/runTurn.ts";
import { loopbackHosts } from "./web/security.ts";
import { createReplyWriter } from "./reply/compose.ts";
import { createDummyJsonApi } from "./retrieval/dummyjson.ts";
import { createRetriever } from "./retrieval/port.ts";
import { createRouterClient } from "./router/classify.ts";
import { createSlotClient } from "./slots/extract.ts";
import { openDatabase } from "./store/db.ts";
import { createStore } from "./store/conversations.ts";

// Checks come first so a missing key never creates or touches the database.
const check = checkStartup(process.env, process.versions.node);
if (!check.ok) {
  console.error(check.message);
  process.exit(1);
}

const { db, warning } = openDatabase(resolve(import.meta.dirname, "..", "data", "conversations.sqlite"));
const store = createStore(db, { warning });

const catalog = createDummyJsonApi({
  baseUrl: "https://dummyjson.com",
  cache: createUrlCache({ ttlMs: 5 * 60_000, maxEntries: 200, now: Date.now }),
});
// Categories are not fetched at boot: the first request pays, and a failure must not stop startup.
const categories = createCategoryNames(catalog, { ttlMs: 60 * 60_000, now: Date.now });

const openai = createOpenAIClient(process.env.OPENAI_API_KEY as string);
const runner = createTurnRunner({
  store,
  router: createRouterClient(openai),
  slots: createSlotClient(openai),
  retriever: createRetriever(catalog),
  categories,
  catalog,
  writer: createReplyWriter(openai),
});

const listen = listenOptions(process.env);
const app = buildApp({ store, runner, warning }, {
  logger: true,
  webRoot: resolve(import.meta.dirname, "..", "..", "web", "dist"),
  allowedHosts: loopbackHosts(listen.port),
});
await app.listen(listen);
