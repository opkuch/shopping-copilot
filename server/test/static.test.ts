import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import type { AppOptions } from "../src/app.ts";
import { createStore } from "../src/store/conversations.ts";
import { openDatabase } from "../src/store/db.ts";
import type { TurnRunner } from "../src/pipeline/ports.ts";
import { containedPath } from "../src/web/static.ts";

const INDEX = "<!doctype html><title>app</title>";
const ASSET = "console.log('asset');";
const SECRET = "SECRET-OUTSIDE-WEBROOT";

// A temp project: <dir>/package.json is outside the build, <dir>/dist is the web root.
function setup(opts: { built?: boolean; app?: Omit<AppOptions, "webRoot"> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "static-"));
  writeFileSync(join(dir, "package.json"), SECRET);
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  if (opts.built ?? true) writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "app-abc123.js"), ASSET);
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  const { db, warning } = openDatabase(join(dir, "c.sqlite"));
  const runner: TurnRunner = {
    run: () => Promise.reject(new Error("no turns in static tests")),
    stage: () => "idle",
    preview: () => null,
  };
  return buildApp({ store: createStore(db, { warning }), runner, warning }, { ...opts.app, webRoot: dist });
}

test("the root and client routes return index.html, not cached, with security headers", async () => {
  const app = setup();
  for (const url of ["/", "/c/abc", "/c/abc/", "/index.html", "/c/abc?x=1"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.body, INDEX, url);
    assert.match(String(res.headers["content-type"]), /^text\/html/, url);
    assert.equal(res.headers["cache-control"], "no-cache", url);
    assert.match(String(res.headers["content-security-policy"]), /default-src 'self'/, url);
    assert.match(String(res.headers["content-security-policy"]), /img-src 'self' https:\/\/cdn\.dummyjson\.com/, url);
    assert.equal(res.headers["x-content-type-options"], "nosniff", url);
    assert.equal(res.headers["referrer-policy"], "no-referrer", url);
  }
});

test("a hashed asset is served with its type and an immutable cache header", async () => {
  const app = setup();
  const res = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, ASSET);
  assert.match(String(res.headers["content-type"]), /^text\/javascript/);
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");

  const icon = await app.inject({ method: "GET", url: "/favicon.svg" });
  assert.equal(icon.statusCode, 200);
  assert.equal(icon.headers["content-type"], "image/svg+xml");
  assert.equal(icon.headers["cache-control"], "no-cache");
});

test("a missing asset is 404, not index.html; a missing page is index.html", async () => {
  const app = setup();
  const asset = await app.inject({ method: "GET", url: "/assets/old-hash.js" });
  assert.equal(asset.statusCode, 404);
  assert.notEqual(asset.body, INDEX);
  const page = await app.inject({ method: "GET", url: "/assets/old-hash.js", headers: { accept: "text/html" } });
  assert.equal(page.statusCode, 200, "a browser navigation still gets the app");
  assert.equal(page.body, INDEX);
});

test("unknown API routes stay JSON 404", async () => {
  const app = setup();
  for (const url of ["/api/nope", "/api", "/api/conversations/x/y"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.json().error.code, "not_found", url);
  }
});

test("paths that escape the web root never return the file", async () => {
  const app = setup();
  const urls = [
    "/../package.json",
    "/%2e%2e/package.json",
    "/%2E%2E/package.json",
    "/..%2fpackage.json",
    "/..%5cpackage.json",
    "/%5c..%5cpackage.json",
    "/assets/../../package.json",
    "/assets/%2e%2e/%2e%2e/package.json",
  ];
  for (const url of urls) {
    for (const accept of [undefined, "text/html"]) {
      const res = await app.inject({ method: "GET", url, headers: accept ? { accept } : {} });
      assert.ok(!res.body.includes(SECRET), `${url} (accept ${accept}) leaked the file`);
    }
  }
});

test("containedPath rejects both separators and absolute paths", () => {
  const root = join(tmpdir(), "root");
  assert.equal(containedPath(root, "/a/b.js"), join(root, "a", "b.js"));
  assert.equal(containedPath(root, "/../x"), null);
  assert.equal(containedPath(root, "/a/../../x"), null);
  if (process.platform === "win32") {
    assert.equal(containedPath(root, "/..\\x"), null);
    assert.equal(containedPath(root, "/C:\\Windows\\win.ini"), null);
  }
});

test("bad encodings and NUL bytes are 400", async () => {
  const app = setup();
  assert.equal((await app.inject({ method: "GET", url: "/%E0%A4%A" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/a%00b" })).statusCode, 400);
});

test("a missing build is a readable 503 and the API still works", async () => {
  const app = setup({ built: false });
  const page = await app.inject({ method: "GET", url: "/c/abc" });
  assert.equal(page.statusCode, 503);
  assert.match(page.body, /npm run setup/);
  const api = await app.inject({ method: "GET", url: "/api/conversations" });
  assert.equal(api.statusCode, 200);
  assert.deepEqual(api.json().conversations, []);
});

test("only GET is served for client routes", async () => {
  const app = setup();
  const res = await app.inject({ method: "POST", url: "/c/abc", payload: {} });
  assert.equal(res.statusCode, 404);
  assert.notEqual(res.body, INDEX);
});

test("API responses are not cached or sniffed", async () => {
  const app = setup();
  const res = await app.inject({ method: "GET", url: "/api/conversations" });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("with a host allowlist, a foreign Host is 421 for pages and the API", async () => {
  const app = setup({ app: { allowedHosts: ["127.0.0.1:3000", "localhost:3000"] } });
  for (const host of ["127.0.0.1:3000", "localhost:3000", "LOCALHOST:3000"]) {
    const res = await app.inject({ method: "GET", url: "/api/conversations", headers: { host } });
    assert.equal(res.statusCode, 200, host);
  }
  for (const host of ["evil.example", "evil.example:3000", "127.0.0.1:3001", "127.0.0.1", ""]) {
    for (const url of ["/api/conversations", "/", "/c/abc"]) {
      const res = await app.inject({ method: "GET", url, headers: { host } });
      assert.equal(res.statusCode, 421, `${host} ${url}`);
    }
  }
  const post = await app.inject({
    method: "POST", url: "/api/conversations", headers: { host: "evil.example" },
    payload: { messageId: "00000000-0000-4000-8000-000000000000", text: "hi" },
  });
  assert.equal(post.statusCode, 421);
});
