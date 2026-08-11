// SPDX-License-Identifier: MIT
/** Seerr/Overseerr SQLite -> unified model importer (users, media, requests, watchlist). */
import { eq } from "drizzle-orm";
import { schema, type Db } from "@medianexus/database";
import type { Importer, SourceDb, ImportReport } from "../importer.types";
import { emptyReport } from "../importer.types";
import { str, num } from "../rows";

const iso = (n?: number | string) => n == null ? new Date().toISOString() : new Date(n).toISOString();

/** Map Overseerr media type + request status to ours. */
function mediaTypeOf(t: unknown): "movie" | "series" {
  return String(t ?? "movie").toLowerCase().startsWith("tv") ? "series" : "movie";
}
function statusOf(s: number): string {
  switch (s) { case 2: return "approved"; case 3: return "declined"; case 4: return "processing"; case 5: return "failed"; case 6: return "fulfilled"; default: return "pending"; }
}

export const seerrImporter: Importer = {
  kind: "seerr",
  matches: (tables) => {
    const t = new Set(tables);
    return (t.has("User") || t.has("Users")) && (t.has("Media") || t.has("mediaRequest") || t.has("Request"));
  },

  async run(source: SourceDb, target: Db): Promise<ImportReport> {
    const report = emptyReport("seerr");
    report.sourceTables = source.tables();
    const tables = source.tables();
    const userTable = tables.includes("Users") ? "Users" : "User";
    const mediaTable = tables.includes("Media") ? "Media" : "media";
    const lower = tables.map((t) => t.toLowerCase());
    const requestTable = lower.includes("mediarequest") ? "MediaRequest"
      : lower.includes("request") ? "Request" : "";

    // users (derived ids; skip if username already exists)
    const userByUpId = new Map<number, string>();
    for (const r of source.all(userTable)) {
      const id = num(r, "id") ?? num(r, "Id"); if (id == null) { report.unknown++; continue; }
      const username = str(r, "username") ?? str(r, "Username") ?? `seed-${id}`;
      const existing = await target.select().from(schema.user).where(eq(schema.user.username, username)).limit(1);
      if (existing[0]) { userByUpId.set(id, existing[0].id); report.skipped++; continue; }
      const derivedId = `imp_seerr_u${id}`;
      await target.insert(schema.user).values({
        id: derivedId, username, email: str(r, "email") ?? null,
        isAdmin: false, roles: ["USER"],
        createdAt: iso(num(r, "createdAt") ?? num(r, "createdAt")), updatedAt: iso(),
      }).onConflictDoNothing();
      userByUpId.set(id, derivedId);
      report.users++;
    }

    // media -> media_availability (by tmdb/tvdb)
    const mediaByUpId = new Map<number, { type: "movie" | "series"; nativeId: string | null }>();
    for (const r of source.all(mediaTable)) {
      const id = num(r, "id") ?? num(r, "Id"); if (id == null) continue;
      const type = mediaTypeOf(colRef(r, "mediaType") ?? colRef(r, "MediaType"));
      const tmdb = num(r, "tmdbId") ?? num(r, "TmdbId");
      const tvdb = num(r, "tvdbId") ?? num(r, "TvdbId");
      const nativeId = await findMedia(target, type, tmdb, tvdb);
      mediaByUpId.set(id, { type, nativeId });
      if (nativeId) {
        await target.insert(schema.mediaAvailability).values({ id: `imp_seerr_m${id}`, mediaType: type, mediaId: nativeId, status: "unknown" }).onConflictDoNothing();
      }
    }

    // requests -> unified request
    if (requestTable) {
      for (const r of source.all(requestTable)) {
        const id = num(r, "id") ?? num(r, "Id"); if (id == null) { report.unknown++; continue; }
        const upMediaId = num(r, "mediaId") ?? num(r, "MediaId");
        const media = upMediaId != null ? mediaByUpId.get(upMediaId) : undefined;
        if (!media) { report.skipped++; continue; }
        const nativeId = media.nativeId;
        if (!nativeId) { report.unknown++; continue; }
        const upUser = num(r, "requestedBy") ?? num(r, "RequestedBy") ?? num(r, "userId");
        const userId = upUser != null ? userByUpId.get(upUser) ?? null : null;
        const status = statusOf(num(r, "status") ?? num(r, "Status") ?? 1);
        await target.insert(schema.request).values({
          id: `imp_seerr_r${id}`,
          userRequestorId: userId,
          mediaType: media.type, mediaId: nativeId, status, isAutoApproval: false,
          requestedAt: iso(num(r, "createdAt") ?? num(r, "createdAt")), updatedAt: iso(),
        }).onConflictDoNothing();
        report.requests++;
      }
    }

    // watchlist (Overseerr stores as JSON on user or a Watchlist table)
    for (const w of (tables.includes("Watchlist") ? source.all("Watchlist") : [])) {
      const upUser = num(w, "userId") ?? num(w, "UserId");
      const tmdb = num(w, "tmdbId") ?? num(w, "TmdbId");
      const type = mediaTypeOf(colRef(w, "mediaType") ?? colRef(w, "MediaType"));
      const userId = upUser != null ? userByUpId.get(upUser) : undefined;
      const nativeId = userId ? await findMedia(target, type, tmdb ?? undefined, undefined) : null;
      if (!userId || !nativeId) continue;
      await target.insert(schema.watchlist).values({ id: `imp_seerr_w${upUser}_${tmdb}`, userId, mediaType: type, mediaId: nativeId, createdAt: iso() }).onConflictDoNothing();
      report.watchlists++;
    }
    return report;
  },
};

function colRef(r: unknown, name: string): unknown {
  if (r && typeof r === "object") return (r as Record<string, unknown>)[name];
  return undefined;
}
async function findMedia(target: Db, type: "movie" | "series", tmdb?: number, tvdb?: number): Promise<string | null> {
  if (type === "movie" && tmdb != null) {
    const rows = await target.select({ id: schema.movie.id }).from(schema.movie).where(eq(schema.movie.tmdbId, tmdb)).limit(1);
    if (rows[0]) return rows[0].id;
  }
  if (type === "series" && tvdb != null) {
    const rows = await target.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tvdbId, tvdb)).limit(1);
    if (rows[0]) return rows[0].id;
  }
  if (type === "series" && tmdb != null) {
    const rows = await target.select({ id: schema.series.id }).from(schema.series).where(eq(schema.series.tvdbId, tmdb)).limit(1);
    if (rows[0]) return rows[0].id;
  }
  return null;
}
