// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, MonitorDown, Search, Database } from "lucide-react";
import { api } from "../api/client";
import type { Series as SeriesRow, Episode, Release } from "../api/types";
import { Badge, ErrorState, formatDate } from "../lib/ui";

interface EpisodeView {
  episode: Episode;
  seasonNumber: number;
}

export default function SeriesDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [queryFor, setQueryFor] = useState<{ season: number; episode: number } | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);

  const series = useQuery({ queryKey: ["series", id], queryFn: () => api.get<SeriesRow>(`/series/${id}`) });
  const episodes = useQuery({ queryKey: ["series-episodes", id], queryFn: () => api.get<EpisodeView[]>(`/series/${id}/episodes`) });
  const setMonitored = useMutation({
    mutationFn: ({ ep, monitored }: { ep: string; monitored: boolean }) => api.put(`/series/${id}/episodes/${ep}`, { monitored }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["series-episodes", id] }),
  });

  const searchEp = useMutation({
    mutationFn: ({ season, episode }: { season: number; episode: number }) =>
      api.post<{ releases: Release[] }>("/search", { mediaType: "series", mediaId: id, query: series.data?.title ?? "", seasons: [season], episodes: [episode] }),
    onSuccess: (data) => setReleases(data.releases),
    onError: () => setReleases([]),
  });

  const grab = useMutation({
    mutationFn: (r: Release) => api.post("/grabs", { mediaType: "series", mediaId: id, releaseId: r.id, indexerId: r.indexerId }),
    onSuccess: () => { setReleases(null); setTimeout(() => qc.invalidateQueries({ queryKey: ["series-episodes", id] }), 400); },
  });

  const runRss = useMutation({
    mutationFn: () => api.post("/system/commands/media.rssSync"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["series-episodes", id] }), 600),
  });

  const importMeta = useMutation({
    mutationFn: () => api.post(`/series/${id}/metadata`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["series", id] }); qc.invalidateQueries({ queryKey: ["series-episodes", id] }); },
  });

  if (series.isError) return <ErrorState error={series.error} onRetry={() => series.refetch()} />;

  const bySeason = new Map<number, EpisodeView[]>();
  for (const e of episodes.data ?? []) {
    const list = bySeason.get(e.seasonNumber) ?? [];
    list.push(e);
    bySeason.set(e.seasonNumber, list);
  }

  return (
    <div className="space-y-4">
      <Link to="/series" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" /> Series
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{series.data?.title}</h2>
          <p className="text-sm text-zinc-500">
            {series.data?.seriesType} · {series.data?.firstAirYear ?? "—"} · {episodes.data?.length ?? 0} episodes
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
        <button
          disabled={importMeta.isPending}
          onClick={() => importMeta.mutate()}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
          title="Fetch seasons/episodes from TMDB (needs metadata.tmdbApiKey)"
        >
          <Database className="h-4 w-4" /> Import from TMDB
        </button>
        <button
          disabled={runRss.isPending}
          onClick={() => runRss.mutate()}
          className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          <MonitorDown className="h-4 w-4" /> {runRss.isPending ? "Syncing…" : "Auto-grab missing (RSS)"}
        </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        {episodes.isLoading ? <p className="p-4 text-sm text-zinc-500">Loading episodes…</p> : episodes.data?.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-500">No episodes yet — add them with the API or wait for metadata import (M5).</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr><th className="px-4 py-2">Season</th><th className="px-4 py-2">Ep</th><th className="px-4 py-2">Title</th><th className="px-4 py-2">Aired</th><th className="px-4 py-2">File</th><th className="px-4 py-2">Monitored</th><th className="px-4 py-2 text-right">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {episodes.data?.map(({ episode, seasonNumber }) => (
                <tr key={episode.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2">S{String(seasonNumber).padStart(2, "0")}</td>
                  <td className="px-4 py-2">E{String(episode.episodeNumber).padStart(2, "0")}</td>
                  <td className="px-4 py-2">{episode.title || "—"}</td>
                  <td className="px-4 py-2 text-zinc-500">{episode.airDateUtc ? formatDate(episode.airDateUtc).slice(0, 10) : "—"}</td>
                  <td className="px-4 py-2"><Badge tone={episode.hasFile ? "ok" : "warn"}>{episode.hasFile ? "file" : "missing"}</Badge></td>
                  <td className="px-4 py-2">
                    <button onClick={() => setMonitored.mutate({ ep: episode.id, monitored: !episode.monitored })} className="text-xs text-zinc-500 hover:underline">
                      {episode.monitored ? "monitored" : "unmonitored"}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1.5">
                      <button
                        disabled={episode.hasFile}
                        onClick={() => { setQueryFor({ season: seasonNumber, episode: episode.episodeNumber }); searchEp.mutate({ season: seasonNumber, episode: episode.episodeNumber }); }}
                        className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-200 dark:text-zinc-900"
                        title="Search & grab this episode"
                      >
                        <Search className="h-3 w-3" /> Grab
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {queryFor && releases && (
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-2 font-medium">
            Releases for S{String(queryFor.season).padStart(2, "0")}E{String(queryFor.episode).padStart(2, "0")}
          </h3>
          {releases.length === 0 ? (
            <p className="text-sm text-zinc-500">No releases returned.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {releases.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                  <span className="truncate">{r.title}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-zinc-500">{r.quality.resolution} · {r.indexerName}</span>
                    <button disabled={grab.isPending} onClick={() => grab.mutate(r)} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500">
                      <Download className="h-3 w-3" /> Grab
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
