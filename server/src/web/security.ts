import type { FastifyInstance } from "fastify";

// The web app's policy. Images come from DummyJSON's CDN; everything else is this origin.
export const CSP = [
  "default-src 'self'",
  "img-src 'self' https://cdn.dummyjson.com data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

/** Host names a loopback server answers to. `port` is the port it listens on. */
export function loopbackHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

// Binding to 127.0.0.1 does not stop DNS rebinding: a page on another domain can re-point that
// domain at 127.0.0.1 and call this API as same-origin. The Host header still names the attacker's
// domain, so rejecting unknown hosts closes it. 421 = "this server does not serve that host".
export function registerHostCheck(app: FastifyInstance, allowedHosts: string[]): void {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) {
      return reply.code(421).type("text/plain; charset=utf-8").send("Misdirected request.");
    }
  });
}

// API responses are per-request JSON: never cached, never content-sniffed.
export function registerApiHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (isApiPath(req.url.split("?", 1)[0] ?? "")) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });
}
