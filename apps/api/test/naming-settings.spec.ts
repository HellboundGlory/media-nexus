// SPDX-License-Identifier: MIT
/** Gap report B7 — media.naming validation on save, and the naming-preview endpoint. */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@medianexus/database";
import { ApiError } from "@medianexus/shared";
import { SystemController } from "../src/system/system.controller";
import { SystemStatusService } from "../src/system/system-status.service";
import { ConfigService } from "../src/system/config.service";

const dir = mkdtempSync(join(tmpdir(), "mn-naming-settings-"));
const handles: { close: () => void }[] = [];
afterAll(() => { for (const h of handles) h.close(); });

let counter = 0;
function controller(): SystemController {
  const handle = createDb(join(dir, `${counter++}.db`));
  handle.runMigrations();
  handles.push(handle);
  return new SystemController(new SystemStatusService(), new ConfigService(handle.db));
}

describe("PUT /system/config — media.naming validation", () => {
  it("accepts a valid custom template pair", async () => {
    const c = controller();
    const result = await c.putConfig({ "media.naming": { movies: "{Quality Full} - {Movie Title}", episodes: "{Series Title} S{season:00}E{episode:00}" } });
    expect((result as never as { "media.naming": { movies: string } })["media.naming"].movies).toBe("{Quality Full} - {Movie Title}");
  });

  it("rejects an unknown movie token", async () => {
    const c = controller();
    await expect(c.putConfig({ "media.naming": { movies: "{Nonexistent}", episodes: "{Series Title}" } })).rejects.toThrow(ApiError);
  });

  it("rejects an unknown episode token", async () => {
    const c = controller();
    await expect(c.putConfig({ "media.naming": { movies: "{Movie Title}", episodes: "{Nonexistent}" } })).rejects.toThrow(ApiError);
  });

  it("rejects a token valid only for the other kind (Series Title in a movie template)", async () => {
    const c = controller();
    await expect(c.putConfig({ "media.naming": { movies: "{Series Title}", episodes: "{Series Title}" } })).rejects.toThrow(ApiError);
  });
});

describe("PUT /system/config — Media Management tab save (NAV-1 Phase 5 regression)", () => {
  // The full body the MediaManagementTab save sends. media.naming MUST be one nested key:
  // putConfig() validates every key against runtimeSettingsSchema's flat key list first, so the
  // old frontend shape ("media.naming.movies" / "media.naming.episodes" as flat keys) rejected
  // the ENTIRE PUT and none of the scalar fields saved either.
  function mediaBody() {
    return {
      "media.naming": { movies: "{Quality Full} - {Movie Title}", episodes: "{Series Title} S{season:00}E{episode:00}" },
      "media.preferredProtocol": "usenet",
      "media.downloadStallMinutes": 30,
      "media.minimumFreeSpaceMb": 200,
      "media.recycleBinPath": "/tmp/recycle",
      "media.recycleBinRetentionDays": 14,
      "paths.downloads": "/tmp/downloads",
    };
  }

  it("accepts the nested media.naming + scalar keys together and persists them", async () => {
    const c = controller();
    await c.putConfig(mediaBody());
    const saved = (await c.getConfig()) as never as {
      "media.naming": { movies: string; episodes: string };
      "media.preferredProtocol": string;
      "media.downloadStallMinutes": number;
      "paths.downloads": string;
    };
    expect(saved["media.naming"].movies).toBe("{Quality Full} - {Movie Title}");
    expect(saved["media.naming"].episodes).toBe("{Series Title} S{season:00}E{episode:00}");
    expect(saved["media.preferredProtocol"]).toBe("usenet");
    expect(saved["media.downloadStallMinutes"]).toBe(30);
    expect(saved["paths.downloads"]).toBe("/tmp/downloads");
  });

  it("rejects the old flat media.naming.movies/episodes keys (guards the Phase 5 regression)", async () => {
    const c = controller();
    await expect(
      c.putConfig({ "media.naming.movies": "{Quality Full}", "media.preferredProtocol": "usenet" } as never),
    ).rejects.toThrow(/Unknown setting keys/i);
  });
});

describe("GET /system/naming/preview", () => {
  it("builds sample filenames from the currently saved templates by default", async () => {
    const c = controller();
    const preview = await c.namingPreview();
    expect(preview.movie).toBe("The Matrix (1999)");
    expect(preview.episode).toBe("Breaking Bad - S01E01 - Pilot");
  });

  it("builds sample filenames from query-supplied templates without persisting them", async () => {
    const c = controller();
    const preview = await c.namingPreview("{Quality Full} - {Movie Title}", "{Series Title} S{season:00}E{episode:00}");
    expect(preview.movie).toBe("Bluray 1080p - The Matrix");
    expect(preview.episode).toBe("Breaking Bad S01E01");

    const saved = await c.getConfig();
    expect((saved as never as { "media.naming": { movies: string } })["media.naming"].movies).toBe("{Movie Title} ({Release Year})");
  });
});
