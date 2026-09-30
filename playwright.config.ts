import { defineConfig, devices } from "@playwright/test";

/**
 * Critical UI workflows against a running stack (`npm run dev`).
 * E2E_BASE_URL defaults to the local web app.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
