// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, HeartPulse, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { IndexerDef, IndexerRow, Release, Paged, Movie } from "../api/types";
import { Badge, ErrorState, formatBytes, statusTone } from "../lib/ui";

interface CardigannSettingMeta {
  name: string;
  label?: string;
  type: string;
  default?: string | number | boolean;
  required?: boolean;
  options?: string[];
}

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function Indexers() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [defKey, setDefKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string | boolean>>({});
  // cardigann custom definition form
  const [showCustom, setShowCustom] = useState(false);
  const [customKey, setCustomKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [customProtocol, setCustomProtocol] = useState<"usenet" | "torrent">("torrent");
  const [customYaml, setCustomYaml] = useState("");
  // search/grabs
  const [movieId, setMovieId] = useState("");
  const [releases, setReleases] = useState<Release[] | null>(null);

  const defs = useQuery({ queryKey: ["indexer-defs"], queryFn: () => api.get<(IndexerDef & { settingsSchema?: CardigannSettingMeta[] })[]>("/indexers/definitions") });
  const indexers = useQuery({ queryKey: ["indexers"], queryFn: () => api.get<IndexerRow[]>("/indexers") });
  const stats = useQuery({ queryKey: ["indexer-stats"], queryFn: () => api.get<any[]>("/indexers/statistics") });
  const movies = useQuery({ queryKey: ["movies"], queryFn: () => api.get<Paged<Movie>>("/movies?pageSize=100") });

  const selectedDef = defs.data?.find((d) => d.key === defKey);

  const addIndexer = useMutation({
    mutationFn: (body: { definitionKey: string; name: string; protocol: "torrent" | "usenet"; settings: Record<string, unknown> }) => api.post("/indexers", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); setName(""); setBaseUrl(""); setApiKey(""); setSettingsDraft({}); },
  });

  const testIndexer = useMutation({
    mutationFn: (id: string) => api.post(`/indexers/${id}/test`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); },
  });
  const removeIndexer = useMutation({ mutationFn: (id: string) => api.del(`/indexers/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); } });

  const createDefinition = useMutation({
    mutationFn: (body: { key: string; name: string; protocol: "usenet" | "torrent"; cardigannYml: string }) => api.post("/indexers/definitions", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexer-defs"] }); setShowCustom(false); setCustomYaml(""); setCustomKey(""); setCustomName(""); },
  });

  const submitIndexer = () => {
    if (!selectedDef) return;
    const settings: Record<string, unknown> = { ...Object.fromEntries(Object.entries(settingsDraft)) };
    if (selectedDef.implementation !== "cardigann") {
      settings.baseUrl = baseUrl;
      settings.apiKey = apiKey;
      settings.categories = [2000, 5000, 5010, 5020, 5030, 5040];
    }
    addIndexer.mutate({ definitionKey: selectedDef.key, name: name || selectedDef.name, protocol: selectedDef.protocol as "torrent" | "usenet", settings });
  };

  const search = useMutation({
    mutationFn: ({ mediaType, mediaId, query }: { mediaType: "movie" | "series"; mediaId: string; query: string }) =>
      api.post<{ releases: Release[] }>("/search", { mediaType, mediaId, query }),
    onSuccess: (data) => setReleases(data.releases),
    onError: () => setReleases([]),
  });

  const grab = useMutation({
    mutationFn: ({ release }: { release: Release }) => api.post("/grabs", { mediaType: "movie", mediaId: movieId, releaseId: release.id, indexerId: release.indexerId, release }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["queue"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); setReleases(null); },
  });

  const cardigannSettings = selectedDef?.implementation === "cardigann" ? (selectedDef.settingsSchema ?? []) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button onClick={() => setShowCustom((v) => !v)} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
          {showCustom ? "Hide custom form" : "New custom (Cardigann)"}
        </button>
      </div>

      {showCustom && (
        <form
          className="space-y-3 rounded-xl border border-rule bg-surface p-4"
          onSubmit={(e) => { e.preventDefault(); createDefinition.mutate({ key: customKey, name: customName, protocol: customProtocol, cardigannYml: customYaml }); }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label><span className="mb-1 block text-xs text-ink-dim">Key (slug)</span>
              <input required value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="my-tracker" className={inputCls} /></label>
            <label><span className="mb-1 block text-xs text-ink-dim">Name</span>
              <input required value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="My Tracker" className={inputCls} /></label>
            <label><span className="mb-1 block text-xs text-ink-dim">Protocol</span>
              <select value={customProtocol} onChange={(e) => setCustomProtocol(e.target.value as never)} className={selectCls}>
                <option value="torrent">Torrent</option><option value="usenet">Usenet</option>
              </select></label>
          </div>
          <label><span className="mb-1 block text-xs text-ink-dim">Cardigann definition (YAML)</span>
            <textarea required rows={7} value={customYaml} onChange={(e) => setCustomYaml(e.target.value)} className={`${inputCls} font-mono text-xs`} placeholder={"name: MyTracker\nsettings:\n  - name: baseUrl\n    type: text\nsearch:\n  paths:\n    - path: /browse\n      inputs:\n        q: \"{{ .Keywords }}\"\n  rows:\n    selector: tr.row\n  fields:\n    title:\n      selector: td.name a\n    details:\n      selector: td.name a\n      attribute: href\n    download:\n      selector: td.name a\n      attribute: href\n    size:\n      selector: td.size\n    seeders:\n      selector: td.seeders"} />
          </label>
          <div className="flex items-center gap-2">
            <button disabled={createDefinition.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
              {createDefinition.isPending ? "Creating…" : "Create definition"}
            </button>
            {createDefinition.isError && <p className="text-xs text-err">{createDefinition.error instanceof Error ? createDefinition.error.message : "Invalid definition"}</p>}
          </div>
        </form>
      )}

      {indexers.isError ? <ErrorState error={indexers.error} onRetry={() => indexers.refetch()} /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-rule bg-surface p-4">
            <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Configure</h3>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">Definition</span>
                <select value={defKey} onChange={(e) => { setDefKey(e.target.value); setSettingsDraft({}); }}
                  className={selectCls}>
                  <option value="">Select…</option>
                  {defs.data?.map((d) => {
                    const cg = d.implementation === "cardigann" ? d.capabilities?.cardigannStatus : undefined;
                    const label = cg && !cg.supported ? " ⚠ unsupported" : (d.implementation === "cardigann" && !d.builtIn ? " (custom)" : "");
                    return <option key={d.key} value={d.key}>{d.name}{label} · {d.protocol}</option>;
                  })}
                </select>
              </label>
              {selectedDef?.implementation === "cardigann" && selectedDef.capabilities?.cardigannStatus && !selectedDef.capabilities.cardigannStatus.supported && (
                <p className="flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn-bg px-3 py-1.5 text-xs text-warn-ink">
                  ⚠ Not usable in this build{selectedDef.capabilities.cardigannStatus.reasons?.length ? `: ${selectedDef.capabilities.cardigannStatus.reasons.join("; ")}` : ""}
                </p>
              )}
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My indexer" className={inputCls} />
              </label>

              {selectedDef?.implementation === "cardigann" ? (
                cardigannSettings.map((s) => (
                  <label key={s.name} className="block">
                    <span className="mb-1 block text-xs text-ink-dim">{s.label ?? s.name}</span>
                    {s.type === "checkbox" ? (
                      <input type="checkbox" onChange={(e) => setSettingsDraft((d) => ({ ...d, [s.name]: e.target.checked }))} />
                    ) : s.type === "number" ? (
                      <input type="number" onChange={(e) => setSettingsDraft((d) => ({ ...d, [s.name]: e.target.value }))} className={inputCls} />
                    ) : (
                      <input onChange={(e) => setSettingsDraft((d) => ({ ...d, [s.name]: e.target.value }))} placeholder={String(s.default ?? "")} className={inputCls} />
                    )}
                  </label>
                ))
              ) : selectedDef ? (
                <>
                  <label className="block"><span className="mb-1 block text-xs text-ink-dim">Base URL</span>
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://indexer.example.com" className={`${inputCls} font-mono`} /></label>
                  <label className="block"><span className="mb-1 block text-xs text-ink-dim">API key (optional)</span>
                    <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={inputCls} /></label>
                </>
              ) : null}

              <button disabled={!defKey || addIndexer.isPending} onClick={submitIndexer} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
                {addIndexer.isPending ? "Adding…" : "Add indexer"}
              </button>
              {addIndexer.isError && <p className="text-xs text-err">{addIndexer.error instanceof Error ? addIndexer.error.message : "Failed"}</p>}
            </div>

            <h3 className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Configured</h3>
            {indexers.isLoading ? <p className="text-sm text-ink-dim">Loading…</p> : indexers.data?.length === 0 ? (
              <p className="text-sm text-ink-dim">None configured yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {indexers.data?.map((i) => (
                  <li key={i.id} className="rounded-lg border border-rule px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{i.name}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                        <button onClick={() => testIndexer.mutate(i.id)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Health check"><HeartPulse className="h-4 w-4" /></button>
                        <button onClick={() => removeIndexer.mutate(i.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button>
                      </span>
                    </div>
                    <p className="truncate font-mono text-xs text-ink-dim">{i.implementation} · {i.protocol}{i.lastError ? ` · ${i.lastError}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Statistics (grabs)</h3>
            {stats.data?.length === 0 ? <p className="text-sm text-ink-dim">No data yet.</p> : (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {stats.data?.map((s) => (
                  <div key={s.id} className="rounded-lg border border-rule px-3 py-2">
                    <p className="truncate font-medium text-ink">{s.name}</p>
                    <p className="text-ink-dim">{s.grabs} grabs{s.lastGrabAt ? ` · last ${new Date(s.lastGrabAt).toLocaleDateString()}` : ""}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-rule bg-surface p-4">
            <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Search & grab</h3>
            <div className="flex flex-col gap-3">
              <label>
                <span className="mb-1 block text-xs text-ink-dim">Movie</span>
                <select value={movieId} onChange={(e) => setMovieId(e.target.value)} className={selectCls}>
                  <option value="">Select a movie…</option>
                  {movies.data?.items.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
                </select>
              </label>
              <button disabled={!movieId || search.isPending} onClick={() => search.mutate({ mediaType: "movie", mediaId: movieId, query: "" })}
                className="w-fit rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-40">
                {search.isPending ? "Searching…" : "Search across indexers"}
              </button>
            </div>
            {releases !== null && (
              <div className="mt-4 space-y-2">
                {releases.length === 0 ? <p className="text-sm text-ink-dim">No releases found.</p> : releases.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{r.title}</p>
                      <p className="text-xs text-ink-dim">{r.indexerName} · {r.quality.source}/{r.quality.resolution} · {formatBytes(r.size)}{r.seeders != null ? ` · ${r.seeders} peers` : ""}</p>
                    </div>
                    <button disabled={grab.isPending} onClick={() => grab.mutate({ release: r })}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
                      <Download className="h-3 w-3" /> Grab
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
