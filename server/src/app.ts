import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./routes/conversations.ts";
import type { RouteDeps } from "./routes/conversations.ts";
import { registerApiHeaders, registerHostCheck } from "./web/security.ts";
import { registerStatic } from "./web/static.ts";

export type AppOptions = {
  logger?: boolean;
  /** Absolute path to the built web app (web/dist). When unset, only the API is served. */
  webRoot?: string;
  /** Accepted Host header values. When unset, any host is accepted (tests that only inject). */
  allowedHosts?: string[];
};

// Separate from server.ts so tests build the app without booting the process.
export function buildApp(deps: RouteDeps, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 });
  if (opts.allowedHosts) registerHostCheck(app, opts.allowedHosts);
  registerApiHeaders(app);
  registerRoutes(app, deps);
  if (opts.webRoot) registerStatic(app, opts.webRoot);
  return app;
}
