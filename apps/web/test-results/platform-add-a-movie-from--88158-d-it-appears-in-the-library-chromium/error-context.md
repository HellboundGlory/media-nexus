# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: platform.spec.ts >> add a movie from the Movies page and it appears in the library
- Location: e2e/platform.spec.ts:20:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Browser Journey Movie')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByText('Browser Journey Movie')

```

```yaml
- complementary:
  - text: M MediaNexus
  - navigation:
    - link "Dashboard":
      - /url: "#/"
    - link "Movies":
      - /url: "#/movies"
    - link "Series":
      - /url: "#/series"
    - link "Calendar":
      - /url: "#/calendar"
    - link "Activity":
      - /url: "#/activity"
    - link "Requests":
      - /url: "#/requests"
    - link "Indexers":
      - /url: "#/indexers"
    - link "Download Clients":
      - /url: "#/clients"
    - link "System":
      - /url: "#/system"
  - text: v0.1.0
  - button "Toggle theme"
- banner: Unified media automation platform
- main:
  - heading "Movies" [level=2]
  - paragraph: 0 titles in library
  - textbox "Search titles…"
  - button "Add movie"
  - text: Title
  - textbox "Title": Browser Journey Movie
  - text: TMDB ID (optional)
  - spinbutton "TMDB ID (optional)"
  - button "Add"
  - paragraph: Cannot POST /api/movies
  - text: Cannot GET /api/movies?search=
  - button "Retry"
```

# Test source

```ts
  1  | // SPDX-License-Identifier: MIT
  2  | import { test, expect, type Page } from "@playwright/test";
  3  | 
  4  | const API_KEY = "e2e-bootstrap-key";
  5  | 
  6  | async function setKey(page: Page) {
  7  |   await page.addInitScript((key) => {
  8  |     localStorage.setItem("medianexus-ui", JSON.stringify({ state: { theme: "dark", apiKey: key }, version: 0 }));
  9  |   }, API_KEY);
  10 | }
  11 | 
  12 | test("dashboard shows system status (End→API wired)", async ({ page }) => {
  13 |   await setKey(page);
  14 |   await page.goto("/#/");
  15 |   await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  16 |   // a system-status-driven stat appears once the API responds
  17 |   await expect(page.locator("text=/API v\\d/")).toBeVisible({ timeout: 10_000 });
  18 | });
  19 | 
  20 | test("add a movie from the Movies page and it appears in the library", async ({ page }) => {
  21 |   await setKey(page);
  22 |   await page.goto("/#/movies");
  23 |   await expect(page.getByRole("heading", { name: "Movies" })).toBeVisible();
  24 |   await page.getByRole("button", { name: /add movie/i }).click();
  25 |   await page.getByLabel(/title/i).fill("Browser Journey Movie");
  26 |   await page.getByRole("button", { name: /^add$/i }).click();
> 27 |   await expect(page.getByText("Browser Journey Movie")).toBeVisible({ timeout: 10_000 });
     |                                                         ^ Error: expect(locator).toBeVisible() failed
  28 | });
  29 | 
  30 | test("Series, Indexers and Clients pages render their headings", async ({ page }) => {
  31 |   await setKey(page);
  32 |   await page.goto("/#/series");
  33 |   await expect(page.getByRole("heading", { name: "Series" })).toBeVisible();
  34 |   await page.goto("/#/indexers");
  35 |   await expect(page.getByRole("heading", { name: "Indexers" })).toBeVisible();
  36 |   await page.goto("/#/clients");
  37 |   await expect(page.getByRole("heading", { name: "Download Clients" })).toBeVisible();
  38 | });
  39 | 
```