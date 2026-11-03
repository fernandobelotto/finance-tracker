import { defineConfig, devices } from "@playwright/test";

// E2E_PORT lets several checkouts/worktrees run the suite side by side.
const PORT = process.env.E2E_PORT ?? "3000";
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Specs other than setup get a fresh, isolated user per test, so they run
  // in parallel. The setup project stays serial because it exercises the
  // global "no users yet" redirect.
  workers: process.env.CI ? 4 : undefined,
  reporter: "html",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      // Setup specs exercise the global "are there any users yet?" redirect
      // logic, so they must run before any other spec creates a user. They
      // run serially (see test.describe.serial in setup.spec.ts) and the
      // chromium project depends on this finishing.
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production-built nitro server. `vite preview` doesn't run SSR for
    // TanStack Start, so E2E builds the app and runs the real prod server
    // — the same code path real users hit.
    command: "pnpm run preview",
    url: BASE_URL,
    env: {
      // Build needs NODE_ENV=production so React Compiler emits prod JSX;
      // the runtime checks TEST_MODE=1 to switch the DB to in-memory PGlite
      // and enable the test-only endpoints. Decoupled so the prod bundle is
      // the real one users hit.
      TEST_MODE: "1",
      HOST: "127.0.0.1",
      PORT,
      AI_FAKE: "1",
      AI_API_KEY: "test-key",
      // Email links inside captured test emails must point at the same
      // origin the browser drives.
      APP_BASE_URL: BASE_URL,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
    reuseExistingServer: false, // We don't want to reuse existing server to avoid writing to the live database! Agents: ask the user to close the server if it's open.
  },
});
