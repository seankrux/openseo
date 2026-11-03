import { defineConfig } from "@playwright/test";

// Explicit, isolated component checks: no app server or provider connection.
export default defineConfig({
  outputDir: "../test-results/bing-components",
  testDir: ".",
  testMatch: "**/bing-connection-card.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
