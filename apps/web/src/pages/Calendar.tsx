// SPDX-License-Identifier: MIT
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
  const start = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
  const entries = useQuery({
    queryKey: ["calendar", start, end],
    queryFn: () => api.get<CalendarEntry[]>(`/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
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
        <h2 className="text-2xl font-semibold tracking-tight">Calendar</h2>
        <p className="text-sm text-zinc-500">Upcoming episode air dates and movie releases (next 30 days).</p>
      </div>
      {entries.isError ? <ErrorState error={entries.error} onRetry={() => entries.refetch()} /> : entries.data?.length === 0 ? (
        <EmptyState title="Nothing scheduled" hint="Episodes with air dates and movie releases (future) will show here." />
      ) : (
        <div className="space-y-3">
          {[...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, list]) => (
            <section key={day} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-2 font-medium text-zinc-600 dark:text-zinc-300">{day === "no date" ? "Unscheduled" : day}</h3>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
                {list.map((e) => (
                  <li key={isEpisode(e) ? e.id : e.movieId} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate">
                      {isEpisode(e) ? (
                        <>
                          <span className="font-medium">{e.seriesTitle}</span>
                          <span className="text-zinc-500"> · S{String(e.seasonNumber).padStart(2, "0")}E{String(e.episodeNumber).padStart(2, "0")}</span>
                          {e.title ? <span className="text-zinc-500"> · {e.title}</span> : null}
                        </>
                      ) : (
                        <>
                          <span className="font-medium">🎬 {e.movieTitle}</span>
                          {e.releaseDate ? <span className="text-zinc-500"> · Movie · {e.releaseDate.slice(0, 4)}</span> : null}
                        </>
                      )}
                    </span>
                    <Badge tone={e.hasFile ? "ok" : e.monitored ? "info" : "neutral"}>{e.hasFile ? "available" : e.monitored ? "wanted" : "unmonitored"}</Badge>
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
