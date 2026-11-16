export type StartupCheck = { ok: true } | { ok: false; message: string };

// Runs before the database is opened: a reviewer's first failure should be one readable line.
export function checkStartup(env: Record<string, string | undefined>, nodeVersion: string): StartupCheck {
  const node = checkNodeVersion(nodeVersion);
  if (!node.ok) return node;
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim() === "") {
    return { ok: false, message: "Set OPENAI_API_KEY in .env; see .env.example" };
  }
  return { ok: true };
}

// The fake-model server (scripts/serve-fake.ts) needs this check but not the API key.
export function checkNodeVersion(nodeVersion: string): StartupCheck {
  const major = Number(nodeVersion.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    return { ok: false, message: `Node 24 or newer is required; found ${nodeVersion}` };
  }
  return { ok: true };
}

// Loopback only: there is no auth, so 0.0.0.0 would expose every chat to the network.
export function listenOptions(env: Record<string, string | undefined>): { host: string; port: number } {
  const port = Number(env.PORT ?? 3000);
  return { host: "127.0.0.1", port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 3000 };
}
