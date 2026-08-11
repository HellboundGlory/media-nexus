// SPDX-License-Identifier: MIT
import { test, expect, type Page } from "@playwright/test";

const API_KEY = "e2e-bootstrap-key";

async function setKey(page: Page) {
  await page.addInitScript((key) => {
    localStorage.setItem("medianexus-ui", JSON.stringify({ state: { theme: "dark", apiKey: key }, version: 0 }));
  }, API_KEY);
}

test("dashboard shows system status (End→API wired)", async ({ page }) => {
  await setKey(page);
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // a system-status-driven stat appears once the API responds
  await expect(page.locator("text=/API v\\d/")).toBeVisible({ timeout: 10_000 });
});

test("add a movie from the Movies page and it appears in the library", async ({ page }) => {
  await setKey(page);
  await page.goto("/#/movies");
  await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();
  await page.getByRole("button", { name: /add movie/i }).click();
  await page.getByLabel(/title/i).fill("Browser Journey Movie");
  await page.getByRole("button", { name: /^add$/i }).click();
  await expect(page.getByText("Browser Journey Movie")).toBeVisible({ timeout: 10_000 });
});

test("Series, Indexers and Clients pages render their headings", async ({ page }) => {
  await setKey(page);
  await page.goto("/#/series");
  await expect(page.getByRole("heading", { name: "Series" })).toBeVisible();
  await page.goto("/#/indexers");
  await expect(page.getByRole("heading", { name: "Indexers" })).toBeVisible();
  await page.goto("/#/clients");
  await expect(page.getByRole("heading", { name: "Download Clients" })).toBeVisible();
});
