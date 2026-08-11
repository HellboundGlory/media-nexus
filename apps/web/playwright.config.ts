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
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node apps/api/dist/main.js",
      cwd: "../../",
      url: "http://127.0.0.1:7373/health/live",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PORT: "7373",
        DATABASE_URL: "file:/tmp/media-nexus-e2e.db",
        MEDIA_NEXUS_SECRET: "e2e-secret-only-123",
        MEDIA_NEXUS_BOOTSTRAP_KEY: "e2e-bootstrap-key",
        MEDIA_NEXUS_BOOTSTRAP_ADMIN_PASSWORD: "e2e-password",
      },
    },
    {
      command: "npm run dev:web",
      cwd: "../../",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
