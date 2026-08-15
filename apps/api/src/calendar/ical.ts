// SPDX-License-Identifier: MIT
/**
 * Minimal RFC 5545 iCalendar (VERSION:2.0) generator for the MediaNexus calendar feed
 * (roadmap P3 "calendar iCal export").
 *
 * Hand-rolled rather than a dependency: the format is a small, well-documented text subset and no
 * suitable generator already exists in this monorepo (checked package.json). Only what calendar
 * apps need for a media calendar is emitted: a VCALENDAR wrapper, one all-day VEVENT per entry
 * (movies on their release date, episodes on their air date), with the text fields RFC-escaped.
 * Line folding is unnecessary here (no generated line approaches 75 octets), but CRLF line endings
 * ARE required by the spec and are used (LF-only output is non-conformant).
 */

import type { CalendarEntry } from "../media/media.repository";

/** RFC 5545 text escaping: backslash, semicolon, comma; newlines become spaces. */
function escapeText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/([\\;,])/g, "\\$1");
}

/** First 10 chars are the YYYY-MM-DD (date or datetime); strip the dashes for an all-day DTSTART. */
function dateOnly(input: string): string {
  return input.slice(0, 10).replace(/-/g, "");
}

function dtStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcal(entries: CalendarEntry[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MediaNexus//MediaNexus//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const e of entries) {
    const uid = e.mediaType === "episode" ? `episode-${e.id}` : `movie-${e.movieId}`;
    const date = e.mediaType === "episode" ? e.airDateUtc : e.releaseDate;
    const summary =
      e.mediaType === "episode"
        ? `${e.seriesTitle} - S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}${e.title ? ` - ${e.title}` : ""}`
        : `${e.movieTitle}${e.releaseDate ? ` (${e.releaseDate.slice(0, 4)})` : ""}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@medianexus`,
      `DTSTAMP:${dtStamp()}`,
      `DTSTART;VALUE=DATE:${dateOnly(date)}`,
      `SUMMARY:${escapeText(summary)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
