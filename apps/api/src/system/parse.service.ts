// SPDX-License-Identifier: MIT
import { Inject, Injectable } from "@nestjs/common";
import { parseReleaseTitle, parseLanguages, parseEpisodeRelease, titleMatches } from "@medianexus/domain";
import { schema } from "@medianexus/database";
import type { Db } from "@medianexus/database";
import { DB_TOKEN } from "../db/database.module";

/**
 * Read-only release-title debug helper (roadmap P3, gap report C8 /parse sub-item).
 *
 * Given a raw release title string, run it through the existing domain parsers and surface
 * everything they extracted — no search, no grab, no side effects. The whole point is
 * visibility into why a release title isn't matching the library, so we return the full
 * parser output rather than trimming it.
 */
@Injectable()
export class ParseService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async parse(title: string) {
    const quality = parseReleaseTitle(title);
    const languages = parseLanguages(title);
    const episodeInfo = parseEpisodeRelease(title);

    // Best-effort library match (stretch, read-only): use the existing media-neutral
    // `titleMatches` against every series/movie title. First match per media type; a debug
    // hint only — deliberately not a hard guarantee, no new matching infra.
    const [seriesRows, movieRows] = await Promise.all([
      this.db.select({ id: schema.series.id, title: schema.series.title }).from(schema.series),
      this.db.select({ id: schema.movie.id, title: schema.movie.title }).from(schema.movie),
    ]);
    const releaseName = (episodeInfo.seriesTitle ?? title).trim();
    let matchedSeriesId: string | null = null;
    let matchedMovieId: string | null = null;
    for (const s of seriesRows) {
      if (titleMatches(releaseName, s.title)) { matchedSeriesId = s.id; break; }
    }
    for (const m of movieRows) {
      if (titleMatches(releaseName, m.title)) { matchedMovieId = m.id; break; }
    }

    return { title, quality, languages, episodeInfo, matchedSeriesId, matchedMovieId };
  }
}
