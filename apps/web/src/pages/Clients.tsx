// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Stethoscope, Trash2, Server, FolderTree, Star, Route } from "lucide-react";
import { api } from "../api/client";
import type { DownloadClient, RootFolder, RemotePathMapping } from "../api/types";
import { Badge, EmptyState, ErrorState } from "../lib/ui";

function formatBytes(n: number | null): string {
  if (n === null || n < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const IMPL_FIELDS: Record<string, { host: string; apiKey: string; extra?: { key: string; label: string; def: string }[] }> = {
  sabnzbd: { host: "SABnzbd host (http://host:8080)", apiKey: "SABnzbd API key", extra: [{ key: "category", label: "Category", def: "movies" }] },
  qbittorrent: { host: "qBittorrent host (http://host:8080)", apiKey: "Password (optional)", extra: [
    { key: "username", label: "Username", def: "admin" }, { key: "tag", label: "Tag", def: "media-nexus" }] },
};

const implKinds: Record<string, "usenet" | "torrent"> = { sabnzbd: "usenet", qbittorrent: "torrent" };
const SERVER_TOKEN_LABEL: Record<string, string> = { jellyfin: "API key", plex: "Token (X-Plex-Token)" };

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function Clients() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [impl, setImpl] = useState<"sabnzbd" | "qbittorrent">("sabnzbd");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [downloads, setDownloads] = useState("");
  const [rootFolderPath, setRootFolderPath] = useState("");
  const [rootFolderName, setRootFolderName] = useState("");
  const [mappingClientId, setMappingClientId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [servers, setServers] = useState<any[]>([]);
  const [serverDraft, setServerDraft] = useState({ name: "", implementation: "jellyfin", host: "", apiKey: "" });

  const clients = useQuery({ queryKey: ["dl-clients"], queryFn: () => api.get<DownloadClient[]>("/download-clients") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, any>>("/system/config") });
  const serversQuery = useQuery({ queryKey: ["media-servers"], queryFn: () => api.get<any[]>("/media-servers") });
  useEffect(() => { if (serversQuery.data) setServers(serversQuery.data); }, [serversQuery.data]);
  const rootFolders = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });
  const mappings = useQuery({ queryKey: ["remote-path-mappings"], queryFn: () => api.get<RemotePathMapping[]>("/remote-path-mappings") });

  const saveServers = useMutation({
    mutationFn: (body: any) => api.post<any>("/media-servers", body),
    onSuccess: () => { serversQuery.refetch(); setServerDraft({ name: "", implementation: "jellyfin", host: "", apiKey: "" }); },
  });
  const removeServer = useMutation({
    mutationFn: (id: string) => api.del(`/media-servers/${id}`),
    onSuccess: () => serversQuery.refetch(),
  });
  const refreshServers = useMutation({ mutationFn: () => api.post("/media-servers/refresh"), onSuccess: () => qc.invalidateQueries({ queryKey: ["indexer-stats"] }) });

  const savePaths = useMutation({
    mutationFn: (body: Record<string, any>) => api.put("/system/config", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const addRootFolder = useMutation({
    mutationFn: () => api.post<RootFolder>("/root-folders", { path: rootFolderPath, name: rootFolderName, isDefault: rootFolders.data?.length === 0 }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["root-folders"] }); setRootFolderPath(""); setRootFolderName(""); },
  });
  const removeRootFolder = useMutation({
    mutationFn: (id: string) => api.del(`/root-folders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["root-folders"] }),
  });

  const addMapping = useMutation({
    mutationFn: () => api.post<RemotePathMapping>("/remote-path-mappings", { downloadClientId: mappingClientId, remotePath, localPath }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["remote-path-mappings"] }); setRemotePath(""); setLocalPath(""); },
  });
  const removeMapping = useMutation({
    mutationFn: (id: string) => api.del(`/remote-path-mappings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["remote-path-mappings"] }),
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
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Clients &amp; Servers</h2>
        <p className="text-sm text-ink-dim">Download clients (SABnzbd, qBittorrent) and media servers (Jellyfin, Plex) via their HTTP APIs.</p>
      </div>

      {clients.isError ? <ErrorState error={clients.error} onRetry={() => clients.refetch()} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-rule bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Configured</h3>
            <button onClick={() => setShowAdd((v) => !v)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
              <Plus className="h-3.5 w-3.5" /> Add client
            </button>
          </div>

          {clients.data?.length === 0 ? (
            <EmptyState title="No download clients" hint="Add an SABnzbd or qBittorrent client to enable real downloads." />
          ) : (
            <ul className="space-y-2 text-sm">
              {clients.data?.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{c.name}</p>
                    <p className="truncate font-mono text-xs text-ink-dim">{c.implementation} · {c.kind}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone="ok">{c.enabled ? "enabled" : "disabled"}</Badge>
                    <button onClick={() => testClient.mutate(c.id)} className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink" title="Health check"><Stethoscope className="h-4 w-4" /></button>
                    <button onClick={() => removeClient.mutate(c.id)} className="rounded p-1.5 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {showAdd && (
            <div className="mt-4 space-y-3 rounded-xl border border-rule p-4">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">Implementation</span>
                <select value={impl} onChange={(e) => setImpl(e.target.value as never)} className={selectCls}>
                  <option value="sabnzbd">SABnzbd (usenet)</option>
                  <option value="qbittorrent">qBittorrent (torrent)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My SABnzbd" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">{fields.host}</span>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="http://192.168.1.10:8080" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-dim">{fields.apiKey}</span>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={inputCls} />
              </label>
              {fields.extra?.map((f) => (
                <label key={f.key} className="block">
                  <span className="mb-1 block text-xs text-ink-dim">{f.label}</span>
                  <input defaultValue={f.def} onChange={(e) => setExtras((x) => ({ ...x, [f.key]: e.target.value }))} className={inputCls} />
                </label>
              ))}
              <div className="flex items-center gap-2">
                <button onClick={submitClient} disabled={addClient.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
                  {addClient.isPending ? "Saving…" : "Save client"}
                </button>
                <button onClick={() => setShowAdd(false)} className="text-sm text-ink-dim hover:underline">Cancel</button>
              </div>
              {addClient.isError && <p className="text-xs text-err">{addClient.error instanceof Error ? addClient.error.message : "Failed"}</p>}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-rule bg-surface p-4">
          <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Downloads staging</h3>
          <p className="mb-3 text-xs text-ink-dim">The importer finds completed downloads here before hardlinking/copying the file into a root folder.</p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-dim">Downloads root (staging)</span>
              <input defaultValue={downloads || (cfg.data?.["paths.downloads"] as string) || ""} onChange={(e) => setDownloads(e.target.value)} placeholder="/data/downloads" className={monoCls} />
            </label>
            <button
              disabled={savePaths.isPending}
              onClick={() => savePaths.mutate({ "paths.downloads": downloads })}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
            >
              {savePaths.isPending ? "Saving…" : "Save"}
            </button>
            {savePaths.isSuccess && <p className="text-xs text-ok">Saved.</p>}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><FolderTree className="h-4 w-4" /> Root folders</h3>
        </div>
        <p className="mb-3 text-xs text-ink-dim">
          Where movies and series are stored. The starred folder is the default assigned to a new title when none is chosen explicitly.
        </p>
        {rootFolders.isError ? <ErrorState error={rootFolders.error} onRetry={() => rootFolders.refetch()} /> : null}
        {rootFolders.data?.length === 0 ? (
          <EmptyState title="No root folders" hint="Add one below — movies/series added without an explicit path fall back to the default." />
        ) : (
          <ul className="mb-3 space-y-2 text-sm">
            {rootFolders.data?.map((rf) => (
              <li key={rf.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule px-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-mono text-xs">
                    {rf.isDefault && <Star className="h-3 w-3 shrink-0 fill-accent text-accent" />}
                    <span className="truncate">{rf.path}</span>
                  </p>
                  <p className="text-xs text-ink-dim">{rf.name || rf.path} · {formatBytes(rf.freeBytes)} free of {formatBytes(rf.totalBytes)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone={rf.accessible ? "ok" : "danger"}>{rf.accessible ? "accessible" : "unreachable"}</Badge>
                  <button onClick={() => removeRootFolder.mutate(rf.id)} className="rounded p-1.5 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-40 flex-1"><span className="mb-1 block text-xs text-ink-dim">Path</span>
            <input value={rootFolderPath} onChange={(e) => setRootFolderPath(e.target.value)} placeholder="/data/media" className={monoCls} /></label>
          <label className="min-w-28"><span className="mb-1 block text-xs text-ink-dim">Name (optional)</span>
            <input value={rootFolderName} onChange={(e) => setRootFolderName(e.target.value)} placeholder="Movies" className={inputCls} /></label>
          <button disabled={!rootFolderPath || addRootFolder.isPending} onClick={() => addRootFolder.mutate()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {addRootFolder.isPending ? "Adding…" : "Add root folder"}
          </button>
        </div>
        {addRootFolder.isError && <p className="mt-2 text-xs text-err">{addRootFolder.error instanceof Error ? addRootFolder.error.message : "Failed"}</p>}
        {removeRootFolder.isError && <p className="mt-2 text-xs text-err">{removeRootFolder.error instanceof Error ? removeRootFolder.error.message : "Failed"}</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Route className="h-4 w-4" /> Remote path mappings</h3>
        </div>
        <p className="mb-3 text-xs text-ink-dim">
          Translates a download client's self-reported content path (its own filesystem view, e.g. inside a container) into the path this app sees.
        </p>
        <ul className="mb-3 space-y-2 text-sm">
          {mappings.data?.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule px-3 py-2">
              <p className="min-w-0 truncate font-mono text-xs">
                {clients.data?.find((c) => c.id === m.downloadClientId)?.name ?? m.downloadClientId}: {m.remotePath} <span className="text-ink-dim">→</span> {m.localPath}
              </p>
              <button onClick={() => removeMapping.mutate(m.id)} className="shrink-0 rounded p-1.5 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          {mappings.data?.length === 0 && <li className="text-sm text-ink-dim">No remote path mappings configured.</li>}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-32"><span className="mb-1 block text-xs text-ink-dim">Download client</span>
            <select value={mappingClientId} onChange={(e) => setMappingClientId(e.target.value)} className={selectCls}>
              <option value="">Select…</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <label className="min-w-40 flex-1"><span className="mb-1 block text-xs text-ink-dim">Remote path (as the client reports it)</span>
            <input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/downloads" className={monoCls} /></label>
          <label className="min-w-40 flex-1"><span className="mb-1 block text-xs text-ink-dim">Local path (as this app sees it)</span>
            <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/mnt/downloads" className={monoCls} /></label>
          <button disabled={!mappingClientId || !remotePath || !localPath || addMapping.isPending} onClick={() => addMapping.mutate()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {addMapping.isPending ? "Adding…" : "Add mapping"}
          </button>
        </div>
        {addMapping.isError && <p className="mt-2 text-xs text-err">{addMapping.error instanceof Error ? addMapping.error.message : "Failed"}</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Server className="h-4 w-4" /> Media servers</h3>
          <button disabled={refreshServers.isPending} onClick={() => refreshServers.mutate()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {refreshServers.isPending ? "Refreshing…" : "Refresh availability"}
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-dim">Jellyfin or Plex (HTTP API). Availability sync marks library items as already available.</p>
        <ul className="mb-3 space-y-2 text-sm">
          {servers.map((s, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg border border-rule px-3 py-2">
              <span className="font-medium text-ink">{s.name}<span className="ml-2 font-mono text-xs text-ink-dim">{s.implementation}</span></span>
              <button onClick={() => removeServer.mutate(s.id)} className="text-xs text-err hover:underline">Remove</button>
            </li>
          ))}
          {servers.length === 0 && <li className="text-sm text-ink-dim">No media servers configured.</li>}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-28"><span className="mb-1 block text-xs text-ink-dim">Name</span>
            <input value={serverDraft.name} onChange={(e) => setServerDraft({ ...serverDraft, name: e.target.value })} placeholder="Plex#1" className={inputCls} /></label>
          <label className="min-w-28"><span className="mb-1 block text-xs text-ink-dim">Type</span>
            <select value={serverDraft.implementation} onChange={(e) => setServerDraft({ ...serverDraft, implementation: e.target.value })} className={selectCls}>
              <option value="jellyfin">Jellyfin</option><option value="plex">Plex</option>
            </select></label>
          <label className="min-w-40 flex-1"><span className="mb-1 block text-xs text-ink-dim">Host</span>
            <input value={serverDraft.host} onChange={(e) => setServerDraft({ ...serverDraft, host: e.target.value })} placeholder={serverDraft.implementation === "plex" ? "http://192.168.1.10:32400" : "http://192.168.1.10:8096"} className={inputCls} /></label>
          <label className="min-w-32"><span className="mb-1 block text-xs text-ink-dim">{SERVER_TOKEN_LABEL[serverDraft.implementation] ?? "API key"}</span>
            <input value={serverDraft.apiKey} onChange={(e) => setServerDraft({ ...serverDraft, apiKey: e.target.value })} className={inputCls} /></label>
          <button disabled={!serverDraft.name} onClick={() => saveServers.mutate({ name: serverDraft.name, implementation: serverDraft.implementation, enabled: true, settings: { host: serverDraft.host, apiKey: serverDraft.apiKey } })}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">Add server</button>
        </div>
        {saveServers.isError && <p className="mt-2 text-xs text-err">{saveServers.error instanceof Error ? saveServers.error.message : "Failed"}</p>}
      </section>
    </div>
  );
}
