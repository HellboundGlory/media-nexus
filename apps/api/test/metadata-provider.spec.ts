// SPDX-License-Identifier: MIT
/**
 * Roadmap P3 (TMDBPROXY) — additive fallback in MetadataService.provider(): TMDB metadata is always
 * available (own key -> real API; no key -> shared Cloudflare proxy /tmdb which injects the real
 * key), and never throws "not configured". An explicit `metadata.tmdbBaseUrl` overrides both.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@medianexus/database";
import { ConfigService } from "../src/system/config.service";
import { EventsService } from "../src/events/events.service";
import { EventBus } from "@medianexus/events";
import { AutoTagsService } from "../src/auto-tags/auto-tags.service";
import { MoviesService } from "../src/movies/movies.service";
import { SeriesService } from "../src/series/series.service";
import { MetadataService } from "../src/metadata/metadata.service";
import { DEFAULT_TMDB_WORKER_URL } from "@medianexus/integrations";

const dir = mkdtempSync(join(tmpdir(), "mn-tmdbproxy-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
async function freshDb() {
  const handle = createDb(join(dir, `tp-${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return handle.db;
}

async function meta(db: Awaited<ReturnType<typeof freshDb>>, settings?: Record<string, string>) {
  const config = new ConfigService(db);
  if (settings) await config.upsert(settings);
  const events = new EventsService(new EventBus());
  const autoTags = new AutoTagsService(db);
  const movies = new MoviesService(db, events, autoTags);
  const series = new SeriesService(db, events, autoTags);
  return new MetadataService(db, config, movies, series, autoTags);
}

function expose(p: Awaited<ReturnType<MetadataService["provider"]>>) {
  return { apiKey: (p as unknown as { settings: { apiKey?: string; baseUrl: string } }).settings.apiKey, baseUrl: (p as unknown as { settings: { baseUrl: string } }).settings.baseUrl };
}

describe("MetadataService.provider() — TMDBPROXY additive fallback", () => {
  it("no key + no baseUrl -> shared proxy /tmdb, apiKey unset", async () => {
    const m = await meta(await freshDb());
    const p = await m.provider();
    expect(expose(p)).toEqual({ apiKey: undefined, baseUrl: DEFAULT_TMDB_WORKER_URL });
  });

  it("own key + no baseUrl -> real TMDB API, apiKey set", async () => {
    const m = await meta(await freshDb(), { "metadata.tmdbApiKey": "my-own-key" });
    const p = await m.provider();
    expect(expose(p)).toEqual({ apiKey: "my-own-key", baseUrl: "https://api.themoviedb.org/3" });
  });

  it("explicit tmdbBaseUrl overrides both modes", async () => {
    const m = await meta(await freshDb(), { "metadata.tmdbApiKey": "my-own-key", "metadata.tmdbBaseUrl": "http://127.0.0.1:1/3" });
    const p = await m.provider();
    expect(expose(p)).toEqual({ apiKey: "my-own-key", baseUrl: "http://127.0.0.1:1/3" });
  });
});
