// SPDX-License-Identifier: MIT
// SeriesDetail — the real series detail page (DETAILPAGE-FE1). Header (poster + meta + chips +
// overview + readout + action bar with the preserved Refresh & Scan (metadata) and the
// series-wide Search Monitored actions), a season-collapsible episode table (real React collapse
// expanded by default), a SeasonPill with hover stats (including size-on-disk summed from
// /files mapped through the episode list), Cast & Crew strip, and a History panel. Episode
// crosshair buttons open the Interactive Search (single-episode scope); the season header's
// crosshair opens a season-pack scope. Every BE1-3 series field is wired: certification,
// runtime, network, trailer link, tmdb rating, cast & crew, rename preview.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Crosshair, FolderOpen, RefreshCw, FileText, Trash2, ChevronDown, ChevronRight, Search, Eye, EyeOff, Pencil } from "lucide-react";
import { clsx } from "clsx";
import { api } from "../api/client";
import type { Series as SeriesRow, Episode, MediaFileRow, QualityProfile, Release } from "../api/types";
import { Badge, ErrorState, formatDate, formatBytes, FormatsBadges } from "../lib/ui";
import { episodeFinaleBadge } from "../lib/episodeFinale";
import { DetailHeader, type ReadoutCell } from "../components/detail/DetailHeader";
import { CompletenessBadge, seriesCompleteness } from "../components/Completeness";
import { CastCrewStrip } from "../components/detail/CastCrewStrip";
import { HistoryPanel } from "../components/detail/HistoryPanel";
import { InteractiveSearchModal, type SearchScope } from "../components/detail/InteractiveSearchModal";
import { RenamePreviewPanel } from "../components/detail/RenamePreviewPanel";
import { ManageFilesModal } from "../components/detail/ManageFilesModal";
import { MonitoredLamp } from "../components/detail/MonitoredLamp";
import { SeasonPill, type SeasonStats } from "../components/detail/SeasonPill";
import { DeleteConfirmModal } from "../components/detail/DeleteConfirmModal";
import { MediaFileActions } from "../components/detail/MediaFileActions";
import { EditTitleModal, type EditTitleBody } from "../components/EditTitleModal";
import { EpisodeDetailModal } from "../components/detail/EpisodeDetailModal";

interface EpisodeView {
  episode: Episode;
  seasonNumber: number;
}

export default function SeriesDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searching, setSearching] = useState<SearchScope | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renamingSeason, setRenamingSeason] = useState<number | null>(null);
  const [managing, setManaging] = useState<{ season?: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number> | null>(null);
  const [epAuto, setEpAuto] = useState<{ epId: string; tone: "ok" | "none" | "error"; text: string } | null>(null);
  const [seasonAuto, setSeasonAuto] = useState<{ seasonNum: number; tone: "ok" | "none" | "error"; text: string } | null>(null);
  const [episodeOpen, setEpisodeOpen] = useState<EpisodeView | null>(null);

  const series = useQuery({ queryKey: ["series", id], queryFn: () => api.get<SeriesRow>(`/series/${id}`) });
  const episodes = useQuery({ queryKey: ["series-episodes", id], queryFn: () => api.get<EpisodeView[]>(`/series/${id}/episodes`) });
  const files = useQuery({ queryKey: ["files", "series", id], queryFn: () => api.get<MediaFileRow[]>(`/series/${id}/files`) });
  // Quality profile names come from /quality-profiles (the page only has qualityProfileId on the
  // series row); the EpisodeDetailModal's Details tab renders the profile name.
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });

  const setEpisodeMonitored = useMutation({
    mutationFn: ({ ep, monitored }: { ep: string; monitored: boolean }) => api.put(`/series/${id}/episodes/${ep}`, { monitored }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["series-episodes", id] }),
  });
  const setSeriesMonitored = useMutation({
    mutationFn: (monitored: boolean) => api.put(`/series/${id}`, { monitored }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["series", id] }),
  });
  // Series-wide monitored auto-search (SERIESDETAIL-1) — replaces the old per-series RSS
  // button, which triggered the GLOBAL passive feed-poll command regardless of what the user
  // was looking at. This targets the one series' monitored-and-missing episodes directly.
  const autoSearchSeries = useMutation({
    mutationFn: () =>
      api.post<{ attempted: number; grabbed: number; error?: string }>(`/series/${id}/auto-search`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["series-episodes", id] }),
  });
  const importMeta = useMutation({
    mutationFn: () => api.post(`/series/${id}/metadata`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["series", id] }); qc.invalidateQueries({ queryKey: ["series-episodes", id] }); },
  });
  const remove = useMutation({
    mutationFn: (opts?: { deleteFiles?: boolean; addImportExclusion?: boolean }) => api.del(`/series/${id}`, opts ?? {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["series"] }); navigate("/series"); },
  });
  const update = useMutation({
    mutationFn: (body: EditTitleBody) => api.put(`/series/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["series", id] }); setEditing(false); },
  });
  const autoSearchEpisode = useMutation({
    mutationFn: ({ epId }: { epId: string }) =>
      api.post<{ grabbed: boolean; release?: Release; error?: string }>(`/series/${id}/episodes/${epId}/auto-search`),
    onSuccess: (d, vars) => {
      qc.invalidateQueries({ queryKey: ["series-episodes", id] });
      if (d.grabbed && d.release) setEpAuto({ epId: vars.epId, tone: "ok", text: `Grabbed: ${d.release.title}` });
      else if (d.error) setEpAuto({ epId: vars.epId, tone: "error", text: d.error });
      else setEpAuto({ epId: vars.epId, tone: "none", text: "No acceptable release found" });
    },
    onError: (e, vars) => setEpAuto({ epId: vars.epId, tone: "error", text: e instanceof Error ? e.message : "Search failed" }),
  });
  // Bulk monitor/unmonitor a whole season: loop the existing per-episode endpoint over every
  // episode in the season (single invalidation at the end, not one per episode).
  const setSeasonMonitored = useMutation({
    mutationFn: async ({ seasonNum, monitored }: { seasonNum: number; monitored: boolean }) => {
      const eps = bySeason.find(([n]) => n === seasonNum)?.[1] ?? [];
      await Promise.all(eps.map(({ episode }) => api.put(`/series/${id}/episodes/${episode.id}`, { monitored })));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["series-episodes", id] }),
  });
  const autoSearchSeason = useMutation({
    mutationFn: ({ seasonNum }: { seasonNum: number }) =>
      api.post<{ attempted: number; grabbed: number; error?: string }>(`/series/${id}/seasons/${seasonNum}/auto-search`),
    onSuccess: (d, vars) => {
      qc.invalidateQueries({ queryKey: ["series-episodes", id] });
      if (d.error) setSeasonAuto({ seasonNum: vars.seasonNum, tone: "error", text: d.error });
      else if (d.grabbed > 0) setSeasonAuto({ seasonNum: vars.seasonNum, tone: "ok", text: `${d.grabbed}/${d.attempted} grabbed` });
      else if (d.attempted > 0) setSeasonAuto({ seasonNum: vars.seasonNum, tone: "none", text: "No acceptable release found" });
      else setSeasonAuto({ seasonNum: vars.seasonNum, tone: "none", text: "No missing episodes" });
    },
    onError: (e, vars) => setSeasonAuto({ seasonNum: vars.seasonNum, tone: "error", text: e instanceof Error ? e.message : "Search failed" }),
  });

  // Hooks must run unconditionally (Rules of Hooks) — these derive from the query results and
  // are safe to compute before the early returns below (they don't depend on `s`).
  const bySeason = useMemo(() => {
    const map = new Map<number, EpisodeView[]>();
    for (const e of episodes.data ?? []) {
      const list = map.get(e.seasonNumber) ?? [];
      list.push(e);
      map.set(e.seasonNumber, list);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]); // most recent first
  }, [episodes.data]);

  // EPISODEDETAIL-1: the highest season number across the series' episodes — the "last season"
  // used to promote a TMDB "finale" episode to "Series Finale" (episodeFinaleBadge).
  const maxSeasonNumber = useMemo(
    () => Math.max(0, ...(episodes.data ?? []).map((e) => e.seasonNumber)),
    [episodes.data],
  );

  // Attribute each series file to its season via the episode list's season numbers, then sum
  // size per season (the SeasonPill's Size on disk — computed client-side from /files, per FE1).
  const sizeBySeason = useMemo(() => {
    const epSeason = new Map<string, number>();
    for (const e of episodes.data ?? []) epSeason.set(e.episode.id, e.seasonNumber);
    const sizes = new Map<number, number>();
    for (const f of files.data ?? []) {
      if (f.episodeIds.length === 0) continue;
      const season = epSeason.get(f.episodeIds[0]);
      if (season === undefined) continue;
      sizes.set(season, (sizes.get(season) ?? 0) + f.size);
    }
    return sizes;
  }, [files.data, episodes.data]);

  // Default: most-recent season expanded, all others collapsed (Sonarr-style). The default is
  // materialized explicitly once the episode list is known — the previous code inferred it from
  // "the collapsed set is empty", which broke the instant the user toggled anything (collapsing
  // the top season un-collapsed every other). Once seeded, `collapsed` is a plain set and
  // isCollapsed is plain set membership, no implicit branching. These hooks MUST stay above the
  // early returns below (Rules of Hooks) — the same reason bySeason/sizeBySeason live up here.
  const defaultCollapsedSet = useMemo(() => {
    const mostRecent = bySeason[0]?.[0];
    return new Set(bySeason.filter(([n]) => n !== mostRecent).map(([n]) => n));
  }, [bySeason]);

  useEffect(() => {
    setCollapsed((prev) => (prev === null && bySeason.length > 0 ? defaultCollapsedSet : prev));
  }, [defaultCollapsedSet, bySeason]);

  if (series.isError) return <ErrorState error={series.error} onRetry={() => series.refetch()} />;
  const s = series.data;
  if (!s) return null;

  // Delete-confirm info derived from the already-fetched file list (root-relative path's first
  // segment IS the title-folder name — the same seriesFolderName the importer writes on disk).
  const firstRel = files.data?.[0]?.relativePath;
  const folderName = firstRel ? firstRel.split("/")[0] : "";
  const folderPath = s.rootFolderPath ? `${s.rootFolderPath.replace(/\/+$/, "")}/${folderName}` : folderName;
  const fileCount = files.data?.length ?? 0;
  const totalBytes = (files.data ?? []).reduce((acc, f) => acc + f.size, 0);

  const toggleSeason = (n: number) => {
    setCollapsed((prev) => {
      const base = prev ?? defaultCollapsedSet;
      const next = new Set(base);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  };
  const isCollapsed = (n: number) => (collapsed ?? defaultCollapsedSet).has(n);

  const seasonStats = (n: number, list: EpisodeView[]): SeasonStats => ({
    total: list.length,
    monitored: list.filter((e) => e.episode.monitored).length,
    withFiles: list.filter((e) => e.episode.hasFile).length,
    sizeOnDisk: sizeBySeason.get(n) ?? 0,
  });

  /** Whether every episode in a season is currently monitored — drives the season-level
   *  monitor toggle (all-monitored → unmonitor-all, otherwise monitor-all). */
  const seasonAllMonitored = (n: number) => {
    const list = bySeason.find(([sn]) => sn === n)?.[1] ?? [];
    return list.length > 0 && list.every((e) => e.episode.monitored);
  };

  const seriesComp = seriesCompleteness(s);
  const readout: ReadoutCell[] = [
    { label: "Root Folder", value: <span className="block max-w-[11rem] truncate font-sans text-sm font-normal normal-case" title={s.rootFolderPath}>{s.rootFolderPath || "—"}</span> },
    { label: "Status", value: <span className="inline-flex items-center gap-2"><span>{s.status || "—"}</span><CompletenessBadge value={seriesComp} missingCount={seriesComp === "missing" ? s.missingEpisodeCount : undefined} /></span> },
    { label: "Episodes", value: episodes.data?.length ?? "—" },
    { label: "Network", value: s.network || "—" },
  ];

  const metaLine = [s.firstAirYear, s.certification, s.runtime ? `${s.runtime}m` : undefined, s.seriesType].filter(Boolean).join(" · ");

  return (
    <div className="space-y-4">
      <Link to="/series" className="inline-flex items-center gap-1 text-sm text-ink-dim hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Series
      </Link>

      <DetailHeader
        title={s.title}
        images={s.images}
        metaLine={metaLine}
        rating={s.tmdbRating}
        genres={s.genres}
        overview={s.overview}
        trailerId={s.trailerId}
        readout={readout}
        mediaType="series"
        tmdbId={s.tmdbId}
        imdbId={s.imdbId}
        actions={
          <>
            <MonitoredLamp monitored={s.monitored} onToggle={() => setSeriesMonitored.mutate(!s.monitored)} busy={setSeriesMonitored.isPending} />
            <button
              onClick={() => importMeta.mutate()}
              disabled={importMeta.isPending}
              title="Refresh series metadata from TMDB"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh &amp; Scan
            </button>
            <button
              onClick={() => autoSearchSeries.mutate()}
              disabled={autoSearchSeries.isPending}
              title="Search and auto-grab the best release for every monitored, missing episode"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" /> {autoSearchSeries.isPending ? "Searching…" : "Search Monitored"}
            </button>
            <button
              onClick={() => setRenaming(true)}
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              <FileText className="h-3.5 w-3.5" /> Preview Rename
            </button>
            <button
              onClick={() => setManaging({})}
              title="Scan every season's folder and reconcile disk vs database"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              <FolderOpen className="h-3.5 w-3.5" /> Manage Episodes
            </button>
            <button
              onClick={() => setEditing(true)}
              title="Edit series settings (quality profile, monitored, series type, path, tags)"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1.5 rounded bg-err/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </>
        }
      />

      {/* Season-collapsible episode table */}
      <section className="space-y-2">
        <h4 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Episodes</h4>
        {episodes.isLoading ? <p className="text-sm text-ink-dim">Loading episodes…</p>
          : episodes.isError ? <ErrorState error={episodes.error} onRetry={() => episodes.refetch()} />
          : bySeason.length === 0 ? <div className="rounded-lg border border-dashed border-rule bg-surface p-6 text-center text-sm text-ink-dim">No episodes yet — import from TMDB to populate them.</div>
          : (
            <div className="space-y-3">
              {bySeason.map(([seasonNum, list]) => {
                const closed = isCollapsed(seasonNum);
                const stats = seasonStats(seasonNum, list);
                return (
                  <div key={seasonNum} className="rounded-lg border border-rule bg-surface">
                    {/* No overflow-hidden here — it clipped the SeasonPill's hover popover (which
                        renders above the header at the very top edge of this box). Rounded corners
                        are kept via the header/table rounding below instead. */}
                    <div className={clsx("flex items-center gap-2 px-3 py-2", closed ? "rounded-lg bg-bg" : "rounded-t-lg border-b border-rule bg-bg")}>
                      <button onClick={() => toggleSeason(seasonNum)} className="flex items-center gap-1.5 font-display text-sm font-semibold uppercase tracking-[0.04em] text-ink">
                        {closed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        Season {seasonNum}
                      </button>
                      <SeasonPill stats={stats} />
                      <button
                        onClick={() => setSeasonMonitored.mutate({ seasonNum, monitored: !seasonAllMonitored(seasonNum) })}
                        // Scope the pending/disabled state to THIS season only. The mutation is shared
                        // across every season row; a bare `setSeasonMonitored.isPending` would dim ALL
                        // seasons' buttons while one season's batch of per-episode PUTs is in flight
                        // (the "flash every season off/on" artifact — DETAILPAGE-FE3).
                        disabled={setSeasonMonitored.isPending && setSeasonMonitored.variables?.seasonNum === seasonNum}
                        title={seasonAllMonitored(seasonNum) ? "Unmonitor all episodes in this season" : "Monitor all episodes in this season"}
                        className={clsx("inline-flex h-6 w-6 items-center justify-center rounded border disabled:opacity-50",
                          seasonAllMonitored(seasonNum) ? "border-ok bg-ok/15 text-ok" : "border-rule text-ink-dim hover:border-ink-dim")}
                      >
                        {seasonAllMonitored(seasonNum) ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </button>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          onClick={() => autoSearchSeason.mutate({ seasonNum })}
                          disabled={autoSearchSeason.isPending}
                          className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-30"
                          title={`Search and auto-grab missing episodes in Season ${seasonNum}`}
                        >
                          <Search className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setSearching({
                            label: `Season ${seasonNum}`, mediaType: "series", mediaId: id,
                            query: s.title, seasons: [seasonNum],
                          })}
                          className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink"
                          title={`Interactive search: whole Season ${seasonNum}`}
                        >
                          <Crosshair className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setRenamingSeason(seasonNum)}
                          className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink"
                          title={`Preview rename for Season ${seasonNum} only`}
                        >
                          <FileText className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setManaging({ season: seasonNum })}
                          className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink"
                          title={`Manage episodes in Season ${seasonNum}`}
                        >
                          <FolderOpen className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {seasonAuto?.seasonNum === seasonNum && (
                      <div className={`px-3 py-1 text-[11px] leading-tight ${seasonAuto.tone === "ok" ? "text-ok" : seasonAuto.tone === "error" ? "text-err" : "text-ink-dim"}`}>
                        {seasonAuto.text}
                      </div>
                    )}

                    {!closed && (
                      <div className="overflow-x-auto rounded-b-lg">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                            <tr>
                              <th className="px-3 py-1.5">Ep</th>
                              <th className="px-3 py-1.5">Title</th>
                              <th className="px-3 py-1.5">Aired</th>
                              <th className="px-3 py-1.5">File</th>
                              <th className="px-3 py-1.5">Monitored</th>
                              <th className="px-3 py-1.5 text-right">Search</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-rule">
                            {list.map(({ episode }) => {
                              const finale = episodeFinaleBadge(episode.episodeType, seasonNum, maxSeasonNumber);
                              return (
                              <tr
                                key={episode.id}
                                onClick={() => setEpisodeOpen({ episode, seasonNumber: seasonNum })}
                                className="cursor-pointer hover:bg-bg/60"
                              >
                                <td className="px-3 py-1.5 tabular-nums text-ink-dim">E{String(episode.episodeNumber).padStart(2, "0")}</td>
                                <td className="px-3 py-1.5">
                                  <span className="inline-flex items-center gap-2">
                                    <span>{episode.title || "—"}</span>
                                    {finale && <Badge tone="info">{finale}</Badge>}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5 text-ink-dim">{episode.airDateUtc ? formatDate(episode.airDateUtc).slice(0, 10) : "—"}</td>
                                <td className="px-3 py-1.5"><Badge tone={episode.hasFile ? "ok" : "warn"}>{episode.hasFile ? "file" : "missing"}</Badge></td>
                                <td className="px-3 py-1.5">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setEpisodeMonitored.mutate({ ep: episode.id, monitored: !episode.monitored }); }}
                                    title={episode.monitored ? "Monitored — click to unmonitor" : "Unmonitored — click to monitor"}
                                    className={clsx("inline-flex h-6 w-6 items-center justify-center rounded border", episode.monitored ? "border-ok bg-ok/15 text-ok" : "border-rule text-ink-dim hover:border-ink-dim")}
                                  >
                                    {episode.monitored ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                  </button>
                                </td>
                                <td className="px-3 py-1.5 text-right">
                                  <div className="flex items-center justify-end gap-0.5">
                                    <button
                                      disabled={episode.hasFile || autoSearchEpisode.isPending}
                                      onClick={(e) => { e.stopPropagation(); autoSearchEpisode.mutate({ epId: episode.id }); }}
                                      className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-30"
                                      title={episode.hasFile ? "Already have this file" : "Search and auto-grab the best release for this episode"}
                                    >
                                      <Search className="h-4 w-4" />
                                    </button>
                                    <button
                                      disabled={episode.hasFile}
                                      onClick={(e) => { e.stopPropagation(); setSearching({
                                        label: `S${String(seasonNum).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")} ${episode.title}`,
                                        mediaType: "series", mediaId: id, query: s.title,
                                        seasons: [seasonNum], episodes: [episode.episodeNumber],
                                      }); }}
                                      className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink disabled:opacity-30"
                                      title={episode.hasFile ? "Already have this file" : "Interactive search: this episode"}
                                    >
                                      <Crosshair className="h-4 w-4" />
                                    </button>
                                  </div>
                                  {epAuto?.epId === episode.id && (
                                    <div className={`mt-1 text-right text-[11px] leading-tight ${epAuto.tone === "ok" ? "text-ok" : epAuto.tone === "error" ? "text-err" : "text-ink-dim"}`}>
                                      {epAuto.text}
                                    </div>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </section>

      {/* Files panel — real media_file rows, same shape/treatment as the movie detail page. */}
      <section className="space-y-2">
        <h4 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Files</h4>
        {files.isLoading ? <p className="text-sm text-ink-dim">Loading…</p>
          : files.isError ? <ErrorState error={files.error} onRetry={() => files.refetch()} />
          : files.data?.length === 0 ? <p className="text-sm text-ink-dim">No files yet.</p>
          : (
            // No overflow-hidden here: MediaFileActions' hover popover must be able to escape the
            // panel (same clipping fix previously applied to SeasonPill).
            <div className="rounded-lg border border-rule">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                  <tr>
                    <th className="px-3 py-2">Path</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Quality</th>
                    <th className="px-3 py-2">Formats</th>
                    <th className="px-3 py-2">Codec</th>
                    <th className="px-3 py-2">Resolution</th>
                    <th className="px-3 py-2">Languages</th>
                    <th className="px-3 py-2">Added</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {files.data?.map((f) => (
                    <tr key={f.id}>
                      <td className="max-w-[26rem] truncate px-3 py-2" title={f.relativePath}>{f.relativePath}</td>
                      <td className="px-3 py-2 tabular-nums text-ink-dim">{formatBytes(f.size)}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.quality ? `${f.quality.source} · ${f.quality.resolution}` : "—"}</td>
                      <td className="px-3 py-2"><FormatsBadges formats={f.matchedFormats} /></td>
                      <td className="px-3 py-2 text-ink-dim">{f.mediaInfo?.videoCodec ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.mediaInfo?.resolution ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.languages.length ? f.languages.join(", ") : "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.dateAdded ? formatDate(f.dateAdded).slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <MediaFileActions file={f} onChanged={() => { qc.invalidateQueries({ queryKey: ["files", "series", id] }); qc.invalidateQueries({ queryKey: ["series", id] }); qc.invalidateQueries({ queryKey: ["series-episodes", id] }); }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <CastCrewStrip mediaType="series" mediaId={id} />
      <HistoryPanel mediaType="series" mediaId={id} />

      {searching && <InteractiveSearchModal scope={searching} onClose={() => setSearching(null)} />}
      {renaming && <RenamePreviewPanel mediaType="series" mediaId={id} onClose={() => setRenaming(false)} />}
      {renamingSeason !== null && <RenamePreviewPanel mediaType="series" mediaId={id} seasonNumber={renamingSeason} onClose={() => setRenamingSeason(null)} />}
      {managing && <ManageFilesModal mediaType="series" mediaId={id} seasonNumber={managing.season} onClose={() => setManaging(null)} />}
      {confirming && (
        <DeleteConfirmModal
          title={s.title}
          mediaType="series"
          folderPath={folderPath}
          folderName={folderName}
          fileCount={fileCount}
          totalBytes={totalBytes}
          busy={remove.isPending}
          onConfirm={(o) => remove.mutate(o)}
          onClose={() => setConfirming(false)}
        />
      )}
      {editing && (
        <EditTitleModal
          mediaType="series"
          initial={{
            monitored: s.monitored,
            qualityProfileId: s.qualityProfileId,
            rootFolderPath: s.rootFolderPath,
            seriesType: (s.seriesType as EditTitleBody["seriesType"]) ?? "standard",
            tags: s.tags,
          }}
          onSave={(body) => update.mutate(body)}
          onClose={() => setEditing(false)}
        />
      )}
      {episodeOpen && (
        <EpisodeDetailModal
          seriesTitle={s.title}
          seasonNumber={episodeOpen.seasonNumber}
          episode={episodeOpen.episode}
          qualityProfileName={profiles.data?.find((p) => p.id === s.qualityProfileId)?.name ?? "—"}
          matchedFile={files.data?.find((f) => f.episodeIds.includes(episodeOpen.episode.id))}
          maxSeasonNumber={maxSeasonNumber}
          onClose={() => setEpisodeOpen(null)}
          onQuickSearch={() => autoSearchEpisode.mutate({ epId: episodeOpen.episode.id })}
          onInteractiveSearch={() => setSearching({
            label: `S${String(episodeOpen.seasonNumber).padStart(2, "0")}E${String(episodeOpen.episode.episodeNumber).padStart(2, "0")} ${episodeOpen.episode.title}`,
            mediaType: "series", mediaId: id, query: s.title,
            seasons: [episodeOpen.seasonNumber], episodes: [episodeOpen.episode.episodeNumber],
          })}
          onFileChanged={() => { qc.invalidateQueries({ queryKey: ["files", "series", id] }); qc.invalidateQueries({ queryKey: ["series-episodes", id] }); }}
        />
      )}
    </div>
  );
}
