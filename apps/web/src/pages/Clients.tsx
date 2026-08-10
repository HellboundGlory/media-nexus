// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Stethoscope, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { DownloadClient } from "../api/types";
import { Badge, EmptyState, ErrorState, formatBytes } from "../lib/ui";

const IMPL_FIELDS: Record<string, { host: string; apiKey: string; extra?: { key: string; label: string; def: string }[] }> = {
  sabnzbd: { host: "SABnzbd host (http://host:8080)", apiKey: "SABnzbd API key", extra: [{ key: "category", label: "Category", def: "movies" }] },
  qbittorrent: { host: "qBittorrent host (http://host:8080)", apiKey: "Password (optional)", extra: [
    { key: "username", label: "Username", def: "admin" }, { key: "tag", label: "Tag", def: "media-nexus" }] },
  memory: { host: "In-memory demo client (no settings)", apiKey: "" },
};

const implKinds: Record<string, "usenet" | "torrent"> = { sabnzbd: "usenet", qbittorrent: "torrent", memory: "torrent" };

export default function Clients() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [impl, setImpl] = useState<"sabnzbd" | "qbittorrent" | "memory">("sabnzbd");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [downloads, setDownloads] = useState("");
  const [rootFolder, setRootFolder] = useState("");

  const clients = useQuery({ queryKey: ["dl-clients"], queryFn: () => api.get<DownloadClient[]>("/download-clients") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, any>>("/system/config") });

  const savePaths = useMutation({
    mutationFn: (body: Record<string, any>) => api.put("/system/config", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const addClient = useMutation({
    mutationFn: (settings: Record<string, unknown>) => api.post("/download-clients", { name, implementation: impl, kind: implKinds[impl], priority: 1, settings }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dl-clients"] }); setShowAdd(false); setName(""); setHost(""); setApiKey(""); setExtras({}); },
  });

  const removeClient = useMutation({ mutationFn: (id: string) => api.del(`/download-clients/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["dl-clients"] }) });
  const testClient = useMutation({ mutationFn: (id: string) => api.post(`/download-clients/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ["dl-clients"] }) });

  const submitClient = () => {
    const settings: Record<string, string> = {};
    if (impl === "sabnzbd") { settings.host = host; settings.apiKey = apiKey; settings.category = extras.category ?? "movies"; }
    else if (impl === "qbittorrent") { settings.host = host; settings.username = extras.username ?? "admin"; settings.password = apiKey; settings.tag = extras.tag ?? "media-nexus"; }
    addClient.mutate(settings);
  };

  const fields = IMPL_FIELDS[impl];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Download Clients</h2>
        <p className="text-sm text-zinc-500">Real downloads: SABnzbd (usenet) and qBittorrent (torrent) are wired via their HTTP APIs. The demo client needs no external service.</p>
      </div>

      {clients.isError ? <ErrorState error={clients.error} onRetry={() => clients.refetch()} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-medium">Configured</h3>
            <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500">
              <Plus className="h-3.5 w-3.5" /> Add client
            </button>
          </div>

          {clients.data?.length === 0 ? (
            <EmptyState title="No download clients" hint="Add an SABnzbd or qBittorrent client to enable real downloads." />
          ) : (
            <ul className="space-y-2 text-sm">
              {clients.data?.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                  <div className="min-w-0">
                    <p className="font-medium">{c.name}</p>
                    <p className="truncate font-mono text-xs text-zinc-500">{c.implementation} · {c.kind}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone="ok">{c.enabled ? "enabled" : "disabled"}</Badge>
                    <button onClick={() => testClient.mutate(c.id)} className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="Health check"><Stethoscope className="h-4 w-4" /></button>
                    <button onClick={() => removeClient.mutate(c.id)} className="rounded p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950" title="Remove"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showAdd && (
            <div className="mt-4 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Implementation</span>
                <select value={impl} onChange={(e) => setImpl(e.target.value as never)} className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
                  <option value="sabnzbd">SABnzbd (usenet)</option>
                  <option value="qbittorrent">qBittorrent (torrent)</option>
                  <option value="memory">Demo (in-memory)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-zinc-500">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My SABnzbd" className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
              </label>
              {impl !== "memory" && (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-500">{fields.host}</span>
                    <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="http://192.168.1.10:8080" className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs text-zinc-500">{fields.apiKey}</span>
                    <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
                  </label>
                  {fields.extra?.map((f) => (
                    <label key={f.key} className="block">
                      <span className="mb-1 block text-xs text-zinc-500">{f.label}</span>
                      <input defaultValue={f.def} onChange={(e) => setExtras((x) => ({ ...x, [f.key]: e.target.value }))} className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
                    </label>
                  ))}
                </>
              )}
              <div className="flex items-center gap-2">
                <button onClick={submitClient} disabled={addClient.isPending} className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                  {addClient.isPending ? "Saving…" : "Save client"}
                </button>
                <button onClick={() => setShowAdd(false)} className="text-sm text-zinc-500 hover:underline">Cancel</button>
              </div>
              {addClient.isError && <p className="text-xs text-red-600">{addClient.error instanceof Error ? addClient.error.message : "Failed"}</p>}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-3 font-medium">Import paths</h3>
          <p className="mb-3 text-xs text-zinc-500">The importer finds completed downloads under the downloads root and hardlinks/copies the file into the library root.</p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Downloads root ({formatBytes(0)} staging)</span>
              <input defaultValue={downloads || (cfg.data?.["paths.downloads"] as string) || ""} onChange={(e) => setDownloads(e.target.value)} placeholder="/data/downloads" className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-500">Library root folder</span>
              <input defaultValue={rootFolder || ((cfg.data?.["paths.rootFolders"] as any[] | undefined)?.[0]?.path) || ""} onChange={(e) => setRootFolder(e.target.value)} placeholder="/data/media" className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
            </label>
            <button
              disabled={savePaths.isPending}
              onClick={() => savePaths.mutate({ "paths.downloads": downloads, "paths.rootFolders": rootFolder ? [{ path: rootFolder }] : undefined })}
              className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
            >
              {savePaths.isPending ? "Saving…" : "Save paths"}
            </button>
            {savePaths.isSuccess && <p className="text-xs text-emerald-600">Paths saved.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
