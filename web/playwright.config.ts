import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// One fake-model server and one database for the whole run (web/PLAN.md "Tests and evaluation").
// Tests never depend on list order: each finds its conversation by its own URL or unique text.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm --prefix ../server run serve:fake",
    url: `http://127.0.0.1:${PORT}/api/conversations`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
