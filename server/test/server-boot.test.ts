import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkStartup, listenOptions } from "../src/boot.ts";

test("checkStartup rejects old Node and a missing or blank key", () => {
  const old = checkStartup({ OPENAI_API_KEY: "k" }, "22.11.0");
  assert.equal(old.ok, false);
  assert.match(old.ok ? "" : old.message, /Node 24 or newer is required; found 22\.11\.0/);
  for (const env of [{}, { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "  " }]) {
    const r = checkStartup(env, "24.1.0");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /Set OPENAI_API_KEY in \.env/);
  }
  assert.deepEqual(checkStartup({ OPENAI_API_KEY: "k" }, "24.0.0"), { ok: true });
  assert.deepEqual(checkStartup({ OPENAI_API_KEY: "k" }, "25.2.1"), { ok: true });
});

test("listenOptions binds loopback only and reads PORT", () => {
  assert.deepEqual(listenOptions({}), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(listenOptions({ PORT: "8080" }), { host: "127.0.0.1", port: 8080 });
  assert.equal(listenOptions({ PORT: "abc" }).host, "127.0.0.1");
});

test("server.ts exits 1 with one readable line when the key is missing, before creating the database", () => {
  const root = resolve(import.meta.dirname, "..");
  const dbPath = resolve(root, "data", "conversations.sqlite");
  const existedBefore = existsSync(dbPath);
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, ["src/server.ts"], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "Set OPENAI_API_KEY in .env; see .env.example");
  assert.equal(existsSync(dbPath), existedBefore);
});
