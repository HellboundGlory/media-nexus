// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E for critical journeys. Boots the real API (apps/api/dist) + the Vite
 * dev server (which proxies /api to the API), then drives the UI with a known key.
 * Prereq: `npm run build:backend` (and web build) done; `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    launchOptions: { args: ["--no-sandbox"] },
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [],
});
