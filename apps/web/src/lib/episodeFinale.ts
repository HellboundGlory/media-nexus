// SPDX-License-Identifier: MIT
// EPISODEDETAIL-1 finding #5: derive the Series Finale / Midseason Finale badge from an episode's
// TMDB episode_type. Shared by the episode table rows and the EpisodeDetailModal header so the
// two never drift. Rules (confirmed against TMDB + Sonarr's own rendering 2026-08-19):
//   mid_season -> "Midseason Finale"
//   finale on the series' LAST season -> "Series Finale"
//   finale on a non-final season -> none (TMDB "finale" just means that season's finale)
//   standard / premiere / null -> none
export function episodeFinaleBadge(
  episodeType: string | null | undefined,
  seasonNumber: number,
  maxSeasonNumber: number,
): string | null {
  if (episodeType === "mid_season") return "Midseason Finale";
  if (episodeType === "finale" && seasonNumber === maxSeasonNumber) return "Series Finale";
  return null;
}
