// SPDX-License-Identifier: MIT
// MovieDetail — the real movie detail page (DETAILPAGE-FE1). Header (poster + meta + chips +
// overview + release dates + readout + action bar), File panel (real media_file rows), Cast &
// Crew strip, and a History panel. Every BE1-3 movie field is wired somewhere: certification,
// runtime, studio, release dates, trailer link, collection chip, tmdb rating, cast & crew,
// rename preview, and reject reasons via the Interactive Search modal.
import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Crosshair, FolderOpen, RefreshCw, Trash2, FileText, Search } from "lucide-react";
import { api } from "../api/client";
import type { Movie, MediaFileRow, Release } from "../api/types";
import { ErrorState, formatBytes, formatDate } from "../lib/ui";
import { DetailHeader, type ReadoutCell } from "../components/detail/DetailHeader";
import { CastCrewStrip } from "../components/detail/CastCrewStrip";
import { HistoryPanel } from "../components/detail/HistoryPanel";
import { InteractiveSearchModal, type SearchScope } from "../components/detail/InteractiveSearchModal";
import { RenamePreviewPanel } from "../components/detail/RenamePreviewPanel";
import { ManageFilesModal } from "../components/detail/ManageFilesModal";
import { MonitoredLamp } from "../components/detail/MonitoredLamp";
import { DeleteConfirmModal } from "../components/detail/DeleteConfirmModal";
import { MediaFileActions } from "../components/detail/MediaFileActions";

export default function MovieDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searching, setSearching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [managing, setManaging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [autoResult, setAutoResult] = useState<{ tone: "ok" | "none" | "error"; text: string } | null>(null);

  const movie = useQuery({ queryKey: ["movie", id], queryFn: () => api.get<Movie>(`/movies/${id}`) });
  const files = useQuery({ queryKey: ["files", "movie", id], queryFn: () => api.get<MediaFileRow[]>(`/movies/${id}/files`) });

  const setMonitored = useMutation({
    mutationFn: (monitored: boolean) => api.put(`/movies/${id}`, { monitored }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["movie", id] }),
  });
  const meta = useMutation({
    mutationFn: () => api.post(`/movies/${id}/metadata`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["movie", id] }); qc.invalidateQueries({ queryKey: ["files", "movie", id] }); },
  });
  const remove = useMutation({
    mutationFn: (opts?: { deleteFiles?: boolean; addImportExclusion?: boolean }) => api.del(`/movies/${id}`, opts ?? {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["movies"] }); navigate("/movies"); },
  });
  const autoSearch = useMutation({
    mutationFn: () => api.post<{ grabbed: boolean; release?: Release; error?: string }>(`/movies/${id}/auto-search`),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["movie", id] });
      if (d.grabbed && d.release) setAutoResult({ tone: "ok", text: `Grabbed: ${d.release.title}` });
      else if (d.error) setAutoResult({ tone: "error", text: d.error });
      else setAutoResult({ tone: "none", text: "No acceptable release found" });
    },
    onError: (e) => setAutoResult({ tone: "error", text: e instanceof Error ? e.message : "Search failed" }),
  });

  if (movie.isError) return <ErrorState error={movie.error} onRetry={() => movie.refetch()} />;
  const m = movie.data;
  if (!m) return null;

  const scope: SearchScope = {
    label: m.title,
    mediaType: "movie",
    mediaId: id,
    query: m.title,
    disabled: m.hasFile,
  };

  const releaseDates = [m.inCinemas, m.digitalRelease, m.physicalRelease].filter(Boolean) as string[];

  const metaLine = [m.releaseDate?.slice(0, 4), m.certification, m.runtime ? `${m.runtime}m` : undefined, m.status].filter(Boolean).join(" · ");

  const readout: ReadoutCell[] = [
    { label: "Root Folder", value: <span className="block max-w-[11rem] truncate font-sans text-sm font-normal normal-case" title={m.rootFolderPath}>{m.rootFolderPath || "—"}</span> },
    { label: "Status", value: m.status || "—" },
    { label: "Studio", value: m.studio || "—" },
    { label: "Files", value: files.data?.length ?? "—" },
  ];

  // Delete-confirm info derived from the already-fetched file list (root-relative path's first
  // segment IS the title-folder name, matching the movieFolderName(s) the importer uses on disk).
  const firstRel = files.data?.[0]?.relativePath;
  const folderName = firstRel ? firstRel.split("/")[0] : "";
  const folderPath = m.rootFolderPath ? `${m.rootFolderPath.replace(/\/+$/, "")}/${folderName}` : folderName;
  const fileCount = files.data?.length ?? 0;
  const totalBytes = (files.data ?? []).reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="space-y-4">
      <Link to="/movies" className="inline-flex items-center gap-1 text-sm text-ink-dim hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Movies
      </Link>

      <DetailHeader
        title={m.title}
        images={m.images}
        metaLine={metaLine}
        rating={m.tmdbRating}
        genres={m.genres}
        overview={m.overview}
        trailerId={m.trailerId}
        collectionName={m.collectionName}
        releaseDates={releaseDates}
        readout={readout}
        mediaType="movie"
        tmdbId={m.tmdbId}
        imdbId={m.imdbId}
        actions={
          <>
            <MonitoredLamp monitored={m.monitored} onToggle={() => setMonitored.mutate(!m.monitored)} busy={setMonitored.isPending} />
            <button
              onClick={() => autoSearch.mutate()}
              disabled={m.hasFile || autoSearch.isPending}
              title={m.hasFile ? "Already have a file" : "Search and auto-grab the best release"}
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-40"
            >
              <Search className="h-3.5 w-3.5" /> {autoSearch.isPending ? "Searching…" : "Search"}
            </button>
            <button
              onClick={() => setSearching(true)}
              disabled={m.hasFile}
              title={m.hasFile ? "Already have a file" : "Search indexers for this movie"}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-40"
            >
              <Crosshair className="h-3.5 w-3.5" /> Interactive Search
            </button>
            <button
              onClick={() => setRenaming(true)}
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              <FileText className="h-3.5 w-3.5" /> Preview Rename
            </button>
            <button
              onClick={() => setManaging(true)}
              title="Scan the folder and reconcile disk vs database"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              <FolderOpen className="h-3.5 w-3.5" /> Manage Files
            </button>
            <button
              onClick={() => meta.mutate()}
              disabled={meta.isPending}
              title="Refresh metadata from TMDB"
              className="inline-flex items-center gap-1.5 rounded bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Metadata
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1.5 rounded bg-err/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-err hover:bg-err/20 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
            {autoResult && (
              <span className={`text-xs font-medium ${autoResult.tone === "ok" ? "text-ok" : autoResult.tone === "error" ? "text-err" : "text-ink-dim"}`}>
                {autoResult.text}
              </span>
            )}
          </>
        }
      />

      {/* File panel — real media_file rows */}
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
                      <td className="px-3 py-2 text-ink-dim">{f.mediaInfo?.videoCodec ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.mediaInfo?.resolution ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.languages.length ? f.languages.join(", ") : "—"}</td>
                      <td className="px-3 py-2 text-ink-dim">{f.dateAdded ? formatDate(f.dateAdded).slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <MediaFileActions file={f} onChanged={() => { qc.invalidateQueries({ queryKey: ["files", "movie", id] }); qc.invalidateQueries({ queryKey: ["movie", id] }); }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <CastCrewStrip mediaType="movie" mediaId={id} />
      <HistoryPanel mediaType="movie" mediaId={id} />

      {searching && <InteractiveSearchModal scope={scope} onClose={() => setSearching(false)} />}
      {renaming && <RenamePreviewPanel mediaType="movie" mediaId={id} onClose={() => setRenaming(false)} />}
      {managing && <ManageFilesModal mediaType="movie" mediaId={id} onClose={() => setManaging(false)} />}
      {confirming && (
        <DeleteConfirmModal
          title={m.title}
          mediaType="movie"
          folderPath={folderPath}
          folderName={folderName}
          fileCount={fileCount}
          totalBytes={totalBytes}
          busy={remove.isPending}
          onConfirm={(o) => remove.mutate(o)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
