// Serves the built web app (web/dist) next to the API, so a reviewer runs one process on one origin.
// Hand-written instead of @fastify/static: we need a SPA fallback and a containment check, not ranges or ETags.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { sendError } from "../routes/conversations.ts";
import { CSP, isApiPath } from "./security.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const NOT_BUILT = "The web app is not built. Run `npm run setup` from the repository root.";

function pageHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("Content-Security-Policy", CSP)
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer");
}

/** The path inside `root`, or null when it resolves outside (`..`, `\` on Windows, absolute paths). */
export function containedPath(root: string, urlPath: string): string | null {
  const target = resolve(root, `.${urlPath}`);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
  return target;
}

export function registerStatic(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const indexPath = join(root, "index.html");

  async function sendIndex(reply: FastifyReply) {
    // Read per request: index.html is small, and a rebuild must show up on the next refresh.
    const html = await readFile(indexPath);
    return pageHeaders(reply).code(200).type(TYPES[".html"] as string).header("Cache-Control", "no-cache").send(html);
  }

  app.get("/*", async (req, reply) => {
    const rawPath = req.url.split("?", 1)[0] ?? "/";
    // Unknown API routes stay JSON, whatever the wildcard matched.
    if (isApiPath(rawPath)) return sendError(reply, 404, "not_found", "No such route.");

    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).type("text/plain; charset=utf-8").send("Bad path.");
    }
    if (path.includes("\0")) return reply.code(400).type("text/plain; charset=utf-8").send("Bad path.");

    if (!existsSync(indexPath)) return reply.code(503).type("text/plain; charset=utf-8").send(NOT_BUILT);

    const target = containedPath(root, path);
    if (target !== null) {
      const info = await stat(target).catch(() => null);
      if (info?.isDirectory() && target === root) return sendIndex(reply);
      if (info?.isFile()) {
        if (target === indexPath) return sendIndex(reply);
        const body = await readFile(target);
        const hashed = relative(root, target).split(sep)[0] === "assets";
        return pageHeaders(reply)
          .code(200)
          .type(TYPES[extname(target).toLowerCase()] ?? "application/octet-stream")
          .header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache")
          .send(body);
      }
    }

    // Only a page navigation falls back to the app. A missing script or image is a real 404, so a tab
    // left open across a rebuild gets a clear failure instead of HTML parsed as JavaScript.
    const last = path.split(/[\\/]/).pop() ?? "";
    const navigation = !last.includes(".") || (req.headers.accept ?? "").includes("text/html");
    if (navigation) return sendIndex(reply);
    return pageHeaders(reply).code(404).type("text/plain; charset=utf-8").send("Not found.");
  });
}
