// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Plus, Search, Check, Film, Tv, RefreshCw } from "lucide-react";
import { api, ApiClientError } from "../api/client";
import type { RootFolder, UnmappedFolders, UnmappedFolder, DiscoverItem } from "../api/types";
import { Badge, EmptyState, ErrorState, Spinner } from "../lib/ui";
import { AddTitleModal, type AddTitleBody } from "../components/AddTitleModal";

/** Library Import (gap report B3): browse a root folder for on-disk titles the library
 *  doesn't know about yet, search TMDB for each, and add it with a stored folder-name
 *  override so files that live in a non-conventional folder are picked up by import/scan.
 *  Reuses the existing metadata.search endpoint and the standard POST /movies|/series
 *  create endpoints — no second search flow. A movie's files are picked up by the on-add
 *  scan that fires on MovieAdded; a series, whose on-add scan runs at create time before any
 *  episodes exist, is given an explicit follow-up scan (POST /library-scan/series/:id) after
 *  its metadata refresh populates episodes — so both types get their files imported as part
 *  of the same add action, not whenever the scheduled scan next fires. */
export default function LibraryImport() {
  const qc = useQueryClient();

  const rootFolders = useQuery({
    queryKey: ["root-folders"],
    queryFn: () => api.get<RootFolder[]>("/root-folders"),
  });

  const [rootId, setRootId] = useState<string | null>(null);
  const [active, setActive] = useState<UnmappedFolder | null>(null);
  const [type, setType] = useState<"movie" | "series">("movie");
  const [query, setQuery] = useState("");
  const [addHit, setAddHit] = useState<DiscoverItem | null>(null);

  const unmapped = useQuery({
    queryKey: ["unmapped", rootId],
    queryFn: () => api.get<UnmappedFolders>(`/root-folders/${rootId}/unmapped`),
    enabled: !!rootId,
  });

  const results = useQuery({
    queryKey: ["metadata-search", active?.name, type, query],
    queryFn: () => api.get<DiscoverItem[]>(`/metadata/search?query=${encodeURIComponent(query)}&type=${type}`),
    enabled: !!active && query.trim().length > 0,
  });

  const add = useMutation({
    mutationFn: async ({ hit, body }: { hit: DiscoverItem; body: AddTitleBody }) => {
      // QUALITYPROFILES-1: the add modal's quality profile / monitored / tags / seriesType merge
      // into the scanned body. rootFolderPath stays exactly what the scan determined (the modal
      // renders it locked/read-only, so it can't diverge).
      const base = {
        title: hit.title,
        tmdbId: hit.tmdbId,
        rootFolderPath: unmapped.data?.path ?? "",
        folderName: active?.name,
        qualityProfileId: body.qualityProfileId,
        monitored: body.monitored,
        tags: body.tags,
      };
      if (type === "movie") {
        return api.post<{ id: string }>("/movies", { ...base, minimumAvailability: body.minimumAvailability });
      }
      const seriesRow = await api.post<{ id: string }>("/series", { ...base, seriesType: body.seriesType });
      // Create episodes/seasons from TMDB, then scan this title so files under the override
      // folder are imported here and now (the on-add scan fired at create time, before any
      // episodes existed, so it had nothing to match — without this follow-up scan a series'
      // files would wait for the scheduled scan). Matches the movie path's immediacy.
      await api.post(`/series/${seriesRow.id}/metadata`).catch(() => undefined);
      await api.post(`/library-scan/series/${seriesRow.id}`).catch(() => undefined);
      return seriesRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [type === "movie" ? "movies" : "series"] });
      qc.invalidateQueries({ queryKey: ["unmapped"] });
      setAddHit(null);
      setActive(null);
    },
  });

  const roots = rootFolders.data ?? [];
  const selectedRoot = roots[0]?.id ?? null;
  const effectiveRootId = rootId ?? selectedRoot;

  const open = (f: UnmappedFolder) => {
    setActive(f);
    setType(f.suggestedMediaType ?? "movie");
    setQuery(f.suggestedTitle ?? f.name);
  };

  return (
    <div className="space-y-4">
      {rootFolders.isError ? (
        <ErrorState error={rootFolders.error} onRetry={() => rootFolders.refetch()} />
      ) : !rootFolders.isLoading && roots.length === 0 ? (
        <EmptyState
          title="No root folders yet"
          hint="Add a root folder under Settings → Download Clients before importing titles."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-dim">
              <FolderOpen className="h-4 w-4" />
              Root folder
              <select
                value={effectiveRootId ?? ""}
                onChange={(e) => { setRootId(e.target.value); setActive(null); }}
                className="rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                {roots.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} — {r.path}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => unmapped.refetch()}
              disabled={unmapped.isFetching}
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${unmapped.isFetching ? "animate-spin" : ""}`} /> Rescan
            </button>
          </div>

          {!effectiveRootId ? null : unmapped.isLoading ? (
            <Spinner label="Scanning folders…" />
          ) : unmapped.isError ? (
            <ErrorState error={unmapped.error} onRetry={() => unmapped.refetch()} />
          ) : (unmapped.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="No unmapped folders" hint="Every folder in this root is already mapped to a title." />
          ) : (
            <div className="space-y-2">
              {unmapped.data!.items.map((f) => {
                const isActive = active?.name === f.name;
                return (
                  <div key={f.name} className="rounded-xl border border-rule bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{f.name}</p>
                        <p className="text-xs text-ink-dim">
                          {f.suggestedTitle && <span className="mr-1">&quot;{f.suggestedTitle}{f.suggestedYear ? ` (${f.suggestedYear})` : ""}&quot;</span>}
                          {f.suggestedMediaType ? <Badge tone="info">{f.suggestedMediaType}</Badge> : <Badge tone="neutral">unknown type</Badge>}
                        </p>
                      </div>
                      {isActive ? (
                        <Badge tone="warn">Importing…</Badge>
                      ) : (
                        <button
                          onClick={() => open(f)}
                          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"
                        >
                          <Plus className="h-3.5 w-3.5" /> Search &amp; add
                        </button>
                      )}
                    </div>

                    {isActive && (
                      <div className="mt-3 space-y-3 border-t border-rule pt-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex gap-1 rounded-lg border border-rule bg-bg p-1">
                            {(["movie", "series"] as const).map((t) => (
                              <button
                                key={t}
                                onClick={() => setType(t)}
                                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${type === t ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-rule hover:text-ink"}`}
                              >
                                {t === "movie" ? <Film className="h-3.5 w-3.5" /> : <Tv className="h-3.5 w-3.5" />} {t === "movie" ? "Movie" : "TV"}
                              </button>
                            ))}
                          </div>
                          <label className="flex-1 basis-64">
                            <span className="mb-1 block text-xs text-ink-dim">Search TMDB</span>
                            <input
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                              placeholder="Title…"
                              className="w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
                            />
                          </label>
                          <button
                            disabled={!query.trim() || results.isFetching}
                            onClick={() => results.refetch()}
                            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
                          >
                            <Search className="h-3.5 w-3.5" /> Search
                          </button>
                        </div>

                        {query.trim().length === 0 ? (
                          <p className="text-xs text-ink-dim">Search to find the title that lives in this folder.</p>
                        ) : results.isLoading ? (
                          <Spinner label="Searching…" />
                        ) : results.isError ? (
                          <p className="text-xs text-err">
                            {(results.error as Error).message}
                            {results.error instanceof ApiClientError && results.error.code === "UNPROCESSABLE"
                              ? " — configure a TMDB key in System → Metadata."
                              : ""}
                          </p>
                        ) : (results.data?.length ?? 0) === 0 ? (
                          <EmptyState title="No matches" hint="Try a different search term." />
                        ) : (
                          <ul className="divide-y divide-rule rounded-lg border border-rule">
                            {results.data!.map((hit: DiscoverItem) => (
                              <li key={hit.tmdbId} className="flex items-center justify-between gap-3 px-3 py-2">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-ink">{hit.title}</p>
                                  <p className="text-xs text-ink-dim">{hit.year ?? "—"}</p>
                                </div>
                                <button
                                  disabled={add.isPending}
                                  onClick={() => setAddHit(hit)}
                                  className="flex shrink-0 items-center gap-1 rounded-lg border border-rule bg-bg px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"
                                >
                                  {add.isPending ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />} Add
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {addHit && (
        <AddTitleModal
          mediaType={addHit.mediaType}
          title={addHit.title}
          posterUrl={addHit.posterUrl}
          lockedRootFolderPath={unmapped.data?.path}
          isPending={add.isPending}
          error={add.error}
          onClose={() => setAddHit(null)}
          onSubmit={(body) => add.mutate({ hit: addHit, body })}
        />
      )}
    </div>
  );
}
