// The real app with scripted models and the recorded catalog, for the browser tests (web/e2e).
// Real store, orchestrator, retrieval, routes, static serving, and host check; no network, no API key.
// A separate script, not a flag on server.ts, so production cannot start in fake mode by accident.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../src/app.ts";
import { checkNodeVersion, listenOptions } from "../src/boot.ts";
import { createCategoryNames } from "../src/catalog/cache.ts";
import { createTurnRunner } from "../src/pipeline/runTurn.ts";
import { createRetriever } from "../src/retrieval/port.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import { loopbackHosts } from "../src/web/security.ts";
import { createFixtureApi } from "../test/fakes/catalog.ts";
import { createRateLimiter } from "../src/web/rateLimit.ts";
import { createScriptedModels } from "../test/fakes/scripted.ts";

const node = checkNodeVersion(process.versions.node);
if (!node.ok) {
  console.error(node.message);
  process.exit(1);
}

// A fresh database per process; never data/conversations.sqlite.
const dir = mkdtempSync(join(tmpdir(), "bazak-fake-"));
const { db, warning } = openDatabase(join(dir, "conversations.sqlite"));
const store = createStore(db, { warning });

const api = createFixtureApi();
const { router, slots } = createScriptedModels();
const runner = createTurnRunner({
  store,
  router,
  slots,
  retriever: createRetriever(api),
  categories: createCategoryNames(api, { ttlMs: 60 * 60_000, now: Date.now }),
  catalog: api,
  // Always the template: deterministic text the browser test can assert on.
  writer: { write: async () => null },
});

const listen = listenOptions({ PORT: process.env.PORT ?? "3100" });
// Browser tests send many messages quickly: no rate limit for the scripted server.
const app = buildApp({ store, runner, warning, limiter: createRateLimiter({ perConversation: Infinity, total: Infinity }) }, {
  webRoot: resolve(import.meta.dirname, "..", "..", "web", "dist"),
  allowedHosts: loopbackHosts(listen.port),
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close().catch(() => {});
  try {
    db.close();
  } catch {}
  // Best effort: on Windows the WAL files can still be locked, and a leftover temp dir is harmless.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen(listen);
console.log(`fake-model server on http://${listen.host}:${listen.port} (database in ${dir})`);
