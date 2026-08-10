// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api } from "../api/client";
import type { IndexerDef, IndexerRow, Release, Paged, Movie } from "../api/types";
import { Badge, formatBytes, statusTone } from "../lib/ui";

export default function Indexers() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [defKey, setDefKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  
  const [movieId, setMovieId] = useState("");
  const [releases, setReleases] = useState<Release[] | null>(null);

  const defs = useQuery({ queryKey: ["indexer-defs"], queryFn: () => api.get<IndexerDef[]>("/indexers/definitions") });
  const indexers = useQuery({ queryKey: ["indexers"], queryFn: () => api.get<IndexerRow[]>("/indexers") });
  const movies = useQuery({ queryKey: ["movies"], queryFn: () => api.get<Paged<Movie>>("/movies?pageSize=100") });

  const addIndexer = useMutation({
    mutationFn: (body: { definitionKey: string; name: string; protocol: "torrent" | "usenet"; settings: Record<string, unknown> }) => api.post("/indexers", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); setName(""); setBaseUrl(""); setApiKey(""); },
  });

  const submitIndexer = (def: IndexerDef) => {
    const settings: Record<string, unknown> = {};
    if (def.implementation === "memory") settings.title = "Demo";
    else { settings.baseUrl = baseUrl; settings.apiKey = apiKey; settings.categories = [2000, 5000, 5010, 5020, 5030, 5040]; }
    addIndexer.mutate({ definitionKey: def.key, name: name || def.name, protocol: def.protocol as "torrent" | "usenet", settings });
  };

  const search = useMutation({
    mutationFn: ({ mediaType, mediaId, query }: { mediaType: "movie" | "series"; mediaId: string; query: string }) =>
      api.post<{ releases: Release[] }>("/search", { mediaType, mediaId, query }),
    onSuccess: (data) => setReleases(data.releases),
    onError: () => setReleases([]),
  });

  const grab = useMutation({
    mutationFn: ({ release }: { release: Release }) => api.post("/grabs", { mediaType: "movie", mediaId: movieId, releaseId: release.id, indexerId: release.indexerId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["queue"] }); setReleases(null); },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Indexers</h2>
        <p className="text-sm text-zinc-500">Configure search sources. Search → grab works today against the in-memory demo provider.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 font-medium">Configure</h3>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Definition</span>
              <select value={defKey} onChange={(e) => setDefKey(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">Select…</option>
                {defs.data?.map((d) => <option key={d.key} value={d.key}>{d.name} ({d.protocol})</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My indexer"
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
            </label>
            {defs.data?.find((d) => d.key === defKey)?.implementation !== "memory" && defKey && (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">Base URL</span>
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://indexer.example.com"
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">API key (optional)</span>
                  <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
                </label>
              </>
            )}
            <button
              disabled={!defKey || addIndexer.isPending}
              onClick={() => { const def = defs.data?.find((d) => d.key === defKey); if (def) submitIndexer(def); }}
              className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {addIndexer.isPending ? "Adding…" : "Add indexer"}
            </button>
            {addIndexer.isError && <p className="text-xs text-red-600">{addIndexer.error instanceof Error ? addIndexer.error.message : "Failed"}</p>}
          </div>

<h3 className="mb-2 mt-5 text-xs uppercase tracking-wide text-zinc-500">Configured</h3>
          {indexers.isLoading ? <p className="text-sm text-zinc-500">Loading…</p> : indexers.data?.length === 0 ? (
            <p className="text-sm text-zinc-500">None configured yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {indexers.data?.map((i) => (
                <li key={i.id} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                  <span className="font-medium">{i.name}</span>
                  <span className="flex items-center gap-2"><span className="font-mono text-xs text-zinc-500">{i.implementation}</span><Badge tone={statusTone(i.status)}>{i.status}</Badge></span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="mb-2 mt-5 text-xs uppercase tracking-wide text-zinc-500">Definition catalog</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {defs.data?.map((d) => (
              <div key={d.id} className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                <p className="font-medium">{d.name}</p>
                <p className="text-zinc-500">{d.protocol} · {d.implementation}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 font-medium">Search & grab (demo)</h3>
          <div className="flex flex-col gap-3">
            <label>
              <span className="mb-1 block text-xs text-zinc-500">Movie</span>
              <select value={movieId} onChange={(e) => setMovieId(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
                <option value="">Select a movie…</option>
                {movies.data?.items.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </label>
            <button disabled={!movieId || search.isPending} onClick={() => search.mutate({ mediaType: "movie", mediaId: movieId, query: "" })}
              className="w-fit rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white">
              {search.isPending ? "Searching…" : "Search (demo releases)"}
            </button>
          </div>

          {releases !== null && (
            <div className="mt-4 space-y-2">
              {releases.length === 0 ? <p className="text-sm text-zinc-500">No releases found.</p> : releases.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="text-xs text-zinc-500">{r.quality.source}/{r.quality.resolution} · {formatBytes(r.size)}{r.seeders != null ? ` · ${r.seeders} peers` : ""}</p>
                  </div>
                  <button disabled={grab.isPending} onClick={() => grab.mutate({ release: r })}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500">
                    <Download className="h-3 w-3" /> Grab
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
