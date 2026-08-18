// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CalendarEntry } from "../api/types";
import { Badge, ErrorState, EmptyState } from "../lib/ui";

function isEpisode(e: CalendarEntry): e is Extract<CalendarEntry, { mediaType: "episode" }> {
  return e.mediaType === "episode";
}

function dayKey(iso: string | null): string {
  if (!iso) return "no date";
  return new Date(iso).toISOString().slice(0, 10);
}

export default function Calendar() {
  // Stable query range: computed ONCE on mount (lazy useState initializer). Computing these
  // inline every render produced a new millisecond-precision ISO string each time, which fed a
  // fresh value into the queryKey and caused an infinite refetch loop (BUGFIX-1 / I10).
  const [range] = useState(() => {
    const start = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
    return { start, end };
  });
  const entries = useQuery({
    queryKey: ["calendar", range.start, range.end],
    queryFn: () => api.get<CalendarEntry[]>(`/calendar?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`),
  });

  const grouped = new Map<string, CalendarEntry[]>();
  for (const e of entries.data ?? []) {
    const k = dayKey(isEpisode(e) ? e.airDateUtc : e.releaseDate);
    const l = grouped.get(k) ?? [];
    l.push(e);
    grouped.set(k, l);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Calendar</h2>
        <p className="text-sm text-ink-dim">Upcoming episode air dates and movie releases (next 30 days).</p>
      </div>
      {entries.isError ? <ErrorState error={entries.error} onRetry={() => entries.refetch()} /> : entries.data?.length === 0 ? (
        <EmptyState title="Nothing scheduled" hint="Episodes with air dates and movie releases (future) will show here." />
      ) : (
        <div className="space-y-3">
          {[...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => (
            <section key={day} className="rounded-xl border border-rule bg-surface p-4">
              <h3 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">{day === "no date" ? "Unscheduled" : day}</h3>
              <ul className="divide-y divide-rule text-sm">
                {list.map((e) => (
                  <li key={isEpisode(e) ? e.id : e.movieId} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate">
                      {isEpisode(e) ? (
                        <>
                          <span className="font-medium text-ink">{e.seriesTitle}</span>
                          <span className="text-ink-dim"> · S{String(e.seasonNumber).padStart(2, "0")}E{String(e.episodeNumber).padStart(2, "0")}</span>
                          {e.title ? <span className="text-ink-dim"> · {e.title}</span> : null}
                        </>
                      ) : (
                        <>
                          <span className="font-medium text-ink">🎬 {e.movieTitle}</span>
                          {e.releaseDate ? <span className="text-ink-dim"> · Movie · {e.releaseDate.slice(0, 4)}</span> : null}
                        </>
                      )}
                    </span>
                    <Badge tone={e.hasFile ? "ok" : e.monitored ? "info" : "neutral"}>{e.hasFile ? "Complete" : e.monitored ? "Missing" : "Unmonitored"}</Badge>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
