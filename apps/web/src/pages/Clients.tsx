// SPDX-License-Identifier: MIT
// Download Clients + Media Servers settings (UNI-018). Card grid + ONE add/edit modal each,
// matching the indexer treatment. Download clients drive both modes from the per-implementation
// field map (qbittorrent: Username/Password/Tag; sabnzbd: API key). The modal Test validates the
// unsaved *draft* (POST /download-clients/test, /media-servers/test); "Test all" health-checks
// every saved provider. Remote path mappings render as an editable table. Root folders moved to
// Media Management (Phase 5).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Pencil, Plus, Server, Trash2, Route } from "lucide-react";
import { api } from "../api/client";
import type { DownloadClient, MediaServer, RemotePathMapping, TagRow } from "../api/types";
import { EmptyState, ErrorState } from "../lib/ui";
import { Modal } from "../components/Modal";
import { ProviderCard } from "../components/ProviderCard";
import { TagPicker } from "../components/TagPicker";
import { PathField } from "../components/PathField";

const REDACTED = "[REDACTED]";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = `${inputCls} font-mono`;
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";
const errTxt = "text-xs text-err";

interface ImplField { key: string; label: string; def?: string; secret?: boolean }
interface ImplSpec {
  host: string;
  apiKey: string;
  secret?: string;
  extra?: ImplField[];
}

const IMPL_FIELDS: Record<string, ImplSpec> = {
  sabnzbd: { host: "SABnzbd host (http://host:8080)", apiKey: "API key", secret: "apiKey", extra: [{ key: "category", label: "Category", def: "movies" }] },
  qbittorrent: {
    host: "qBittorrent host (http://host:8080)", apiKey: "Password",
    extra: [
      { key: "username", label: "Username", def: "admin" },
      { key: "password", label: "Password", def: "", secret: true },
      { key: "tag", label: "Tag", def: "media-nexus" },
    ],
  },
  nzbget: {
    host: "NZBGet host (http://host:6789)",
    apiKey: "",
    extra: [
      { key: "username", label: "Username", def: "nzbget" },
      { key: "password", label: "Password", def: "", secret: true },
      { key: "category", label: "Category", def: "movies" },
      // NZBGet's per-job download priority (int), distinct from the client-selection
      // "Priority" field above (cPriority) — never conflate the two (NZBGET-1).
      { key: "priority", label: "Job priority", def: "0" },
    ],
  },
};

const CLIENT_IMPL_OPTIONS = Object.keys(IMPL_FIELDS);
const implKinds: Record<string, "usenet" | "torrent"> = { sabnzbd: "usenet", nzbget: "usenet", qbittorrent: "torrent" };
const SERVER_TOKEN_LABEL: Record<string, string> = { jellyfin: "API key", plex: "Token (X-Plex-Token)" };

export default function Clients() {
  const qc = useQueryClient();
  // download client modal
  const [clientModal, setClientModal] = useState<{ editing: DownloadClient | null; adding: boolean }>({ editing: null, adding: false });
  const [cImpl, setCImpl] = useState("sabnzbd");
  const [cName, setName] = useState("");
  const [cEnabled, setCEnabled] = useState(true);
  const [cPriority, setCPriority] = useState("1");
  const [cSettings, setCSettings] = useState<Record<string, string>>({});
  const [cTags, setCTags] = useState<string[]>([]);
  // media server modal
  const [serverModal, setServerModal] = useState<{ editing: MediaServer | null; adding: boolean }>({ editing: null, adding: false });
  const [sName, setSName] = useState("");
  const [sImpl, setSImpl] = useState<"jellyfin" | "plex">("jellyfin");
  const [sEnabled, setSEnabled] = useState(true);
  const [sHost, setSHost] = useState("");
  const [sKey, setSKey] = useState("");
  // remote path mapping modal
  const [mappingEdit, setMappingEdit] = useState<RemotePathMapping | null>(null);
  const [rpmClientId, setRpmClientId] = useState("");
  const [rpmRemote, setRpmRemote] = useState("");
  const [rpmLocal, setRpmLocal] = useState("");
  // downloads staging
  const [downloads, setDownloads] = useState("");

  const clients = useQuery({ queryKey: ["dl-clients"], queryFn: () => api.get<DownloadClient[]>("/download-clients") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, any>>("/system/config") });
  const serversQuery = useQuery({ queryKey: ["media-servers"], queryFn: () => api.get<MediaServer[]>("/media-servers") });
  const mappings = useQuery<RemotePathMapping[]>({ queryKey: ["remote-path-mappings"], queryFn: () => api.get("/remote-path-mappings") });
  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: () => api.get<TagRow[]>("/tags") });
  const tagLookup = useMemo(() => new Map((tagsQuery.data ?? []).map((t) => [t.id, t])), [tagsQuery.data]);

  // ---- download client mutations ----
  const saveClient = useMutation({
    mutationFn: async () => {
      const settings = buildClientSettings();
      if (clientModal.editing) return api.put(`/download-clients/${clientModal.editing.id}`, { name: cName, enabled: cEnabled, priority: Number(cPriority) || 1, settings, tags: cTags });
      return api.post("/download-clients", { name: cName, implementation: cImpl, kind: implKinds[cImpl], priority: Number(cPriority) || 1, settings, tags: cTags });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dl-clients"] }); closeClient(); },
  });
  const testClientDraft = useMutation({
    mutationFn: () => api.post<{ ok: boolean; latencyMs: number; message: string }>("/download-clients/test", {
      ...(clientModal.editing ? { id: clientModal.editing.id } : {}),
      name: cName,
      implementation: clientModal.editing?.implementation ?? cImpl,
      kind: clientModal.editing?.kind ?? implKinds[cImpl],
      settings: buildClientSettings(),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dl-clients"] }),
  });
  const testAllClients = useMutation({
    mutationFn: () => api.post<{ checked: number; ok: number; failed: number }>("/download-clients/refresh-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dl-clients"] }),
  });
  const removeClient = useMutation({
    mutationFn: (id: string) => api.del(`/download-clients/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dl-clients"] }); closeClient(); },
  });

  // ---- media server mutations ----
  const saveServer = useMutation({
    mutationFn: async () => {
      const settings = { host: sHost, apiKey: sKey };
      if (serverModal.editing) return api.put(`/media-servers/${serverModal.editing.id}`, { name: sName, enabled: sEnabled, settings });
      return api.post("/media-servers", { name: sName, implementation: sImpl, enabled: sEnabled, settings });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["media-servers"] }); closeServer(); },
  });
  const testServerDraft = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>("/media-servers/test", {
      ...(serverModal.editing ? { id: serverModal.editing.id } : {}),
      name: sName,
      implementation: serverModal.editing?.implementation ?? sImpl,
      settings: { host: sHost, apiKey: sKey },
    }),
  });
  const testAllServers = useMutation({
    mutationFn: () => api.post("/media-servers/refresh"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["indexer-stats"] }),
  });
  const removeServer = useMutation({
    mutationFn: (id: string) => api.del(`/media-servers/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["media-servers"] }); closeServer(); },
  });

  // ---- root folders + remote paths ----
  const savePaths = useMutation({
    mutationFn: (body: Record<string, any>) => api.put("/system/config", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const saveMapping = useMutation({
    mutationFn: async () => {
      if (mappingEdit) return api.put(`/remote-path-mappings/${mappingEdit.id}`, { remotePath: rpmRemote, localPath: rpmLocal });
      return api.post<RemotePathMapping>("/remote-path-mappings", { downloadClientId: rpmClientId, remotePath: rpmRemote, localPath: rpmLocal });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["remote-path-mappings"] }); closeMapping(); },
  });
  const removeMapping = useMutation({ mutationFn: (id: string) => api.del(`/remote-path-mappings/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["remote-path-mappings"] }) });

  function buildClientSettings(): Record<string, string> {
    const impl = clientModal.editing?.implementation ?? cImpl;
    const spec = IMPL_FIELDS[impl] ?? { host: "Host", extra: [] };
    const settings: Record<string, string> = { host: cSettings.host ?? "" };
    if (spec.secret) settings[spec.secret] = cSettings[spec.secret] ?? "";
    for (const f of spec.extra ?? []) settings[f.key] = cSettings[f.key] ?? (f.def ?? "");
    return settings;
  }

  function openClientAdd() {
    setClientModal({ editing: null, adding: true });
    setCImpl("sabnzbd");
    setName(""); setCEnabled(true); setCPriority("1"); setCSettings({}); setCTags([]);
  }
  function openClientEdit(row: DownloadClient) {
    setClientModal({ editing: row, adding: false });
    setCImpl(row.implementation);
    setName(row.name); setCEnabled(row.enabled); setCPriority(String(row.priority ?? 1));
    const s: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.settings ?? {})) s[k] = String(v);
    setCSettings(s);
    setCTags(row.tags ?? []);
  }
  function closeClient() { setClientModal({ editing: null, adding: false }); }

  function openServerAdd() {
    setServerModal({ editing: null, adding: true });
    setSName(""); setSImpl("jellyfin"); setSEnabled(true); setSHost(""); setSKey("");
  }
  function openServerEdit(row: MediaServer) {
    setServerModal({ editing: row, adding: false });
    setSName(row.name); setSImpl(row.implementation); setSEnabled(row.enabled);
    setSHost(String(row.settings?.host ?? "")); setSKey(String(row.settings?.apiKey ?? ""));
  }
  function closeServer() { setServerModal({ editing: null, adding: false }); }

  function openMappingAdd() { setMappingEdit(null); setRpmClientId(""); setRpmRemote(""); setRpmLocal(""); }
  function openMappingEdit(m: RemotePathMapping) { setMappingEdit(m); setRpmClientId(m.downloadClientId); setRpmRemote(m.remotePath); setRpmLocal(m.localPath); }
  function closeMapping() { setMappingEdit(null); }

  const clientOpen = clientModal.adding || clientModal.editing !== null;
  const serverOpen = serverModal.adding || serverModal.editing !== null;
  const mappingOpen = mappingEdit !== null;
  const clientIsEdit = clientModal.editing !== null;
  const serverIsEdit = serverModal.editing !== null;
  const clientImpl = clientModal.editing?.implementation ?? cImpl;
  const cFields = IMPL_FIELDS[clientImpl] ?? { host: "Host (http://…)", apiKey: "API key / password" };

  return (
    <div className="space-y-6">
      {/* Download clients */}
      {clients.isError ? <ErrorState error={clients.error} onRetry={() => clients.refetch()} /> : (
        <section className="rounded-xl border border-rule bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Download clients</h3>
            <button onClick={() => testAllClients.mutate()} disabled={testAllClients.isPending} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50">
              <HeartPulse className="h-3.5 w-3.5" /> {testAllClients.isPending ? "Testing…" : "Test all"}
            </button>
          </div>
          {clients.data?.length === 0 ? (
            <EmptyState title="No download clients" hint="Add an SABnzbd, NZBGet or qBittorrent client to enable real downloads." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {clients.data?.map((c) => (
                <ProviderCard
                  key={c.id}
                  name={c.name}
                  subLine={`${c.implementation} · ${c.kind} · priority ${c.priority}`}
                  enabled={c.enabled}
                  protocol={c.kind}
                  tags={c.tags}
                  tagLookup={tagLookup}
                  onClick={() => openClientEdit(c)}
                />
              ))}
              <button
                type="button"
                onClick={openClientAdd}
                className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed border-rule bg-surface text-sm font-semibold uppercase tracking-wide text-ink-dim transition-colors hover:border-accent/50 hover:text-ink"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
          )}
        </section>
      )}

      {/* Downloads staging + remote path mappings */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-rule bg-surface p-4">
          <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Downloads staging</h3>
          <p className="mb-3 text-xs text-ink-dim">The importer finds completed downloads here before hardlinking/copying the file into a root folder.</p>
          <div className="space-y-3">
            <label className="block">
              <span className={labelCls}>Downloads root (staging)</span>
              <PathField value={downloads || (cfg.data?.["paths.downloads"] as string) || ""} onChange={setDownloads} placeholder="/data/downloads" />
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

        <section className="rounded-xl border border-rule bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Route className="h-4 w-4" /> Remote path mappings</h3>
            <button onClick={openMappingAdd} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"><Plus className="h-3.5 w-3.5" /> Add</button>
          </div>
          <p className="mb-3 text-xs text-ink-dim">Translates a download client's self-reported content path into the path this app sees.</p>
          {mappings.data?.length === 0 ? (
            <p className="text-sm text-ink-dim">No remote path mappings configured.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-rule">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                  <tr><th className="px-3 py-2">Client</th><th className="px-3 py-2">Remote path</th><th className="px-3 py-2">Local path</th><th className="px-3 py-2 text-right">Actions</th></tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {mappings.data?.map((m) => (
                    <tr key={m.id} className="hover:bg-bg/60">
                      <td className="px-3 py-2 font-medium text-ink">{clients.data?.find((c) => c.id === m.downloadClientId)?.name ?? m.downloadClientId}</td>
                      <td className="px-3 py-2 font-mono text-xs text-ink-dim">{m.remotePath}</td>
                      <td className="px-3 py-2 font-mono text-xs text-ink-dim">{m.localPath}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => openMappingEdit(m)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => removeMapping.mutate(m.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Media servers */}
      {serversQuery.isError ? <ErrorState error={serversQuery.error} onRetry={() => serversQuery.refetch()} /> : (
        <section className="rounded-xl border border-rule bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Server className="h-4 w-4" /> Media servers</h3>
            <div className="flex items-center gap-2">
              <button disabled={testAllServers.isPending} onClick={() => testAllServers.mutate()} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50">Refresh availability</button>
            </div>
          </div>
          <p className="mb-3 text-xs text-ink-dim">Jellyfin or Plex (HTTP API). Availability sync marks library items as already available.</p>
          {serversQuery.data?.length === 0 ? (
            <EmptyState title="No media servers" hint="Add a Jellyfin or Plex server to sync library availability." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {serversQuery.data?.map((s) => (
                <ProviderCard
                  key={s.id}
                  name={s.name}
                  subLine={s.implementation}
                  enabled={s.enabled}
                  onClick={() => openServerEdit(s)}
                />
              ))}
              <button
                type="button"
                onClick={openServerAdd}
                className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed border-rule bg-surface text-sm font-semibold uppercase tracking-wide text-ink-dim transition-colors hover:border-accent/50 hover:text-ink"
              >
                <Plus className="h-4 w-4" /> Add
              </button>
            </div>
          )}
        </section>
      )}

      {/* Download client modal */}
      {clientOpen && (
        <Modal
          title={clientIsEdit ? `Edit ${clientModal.editing?.name ?? "client"}` : "Add download client"}
          onClose={closeClient}
          footer={<>
            {clientIsEdit && clientModal.editing && (
              <button onClick={() => removeClient.mutate(clientModal.editing!.id)} className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err-bg">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            )}
            <button onClick={() => testClientDraft.mutate()} disabled={testClientDraft.isPending} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule disabled:opacity-50">{testClientDraft.isPending ? "Testing…" : "Test"}</button>
            <button onClick={closeClient} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
            <button onClick={() => saveClient.mutate()} disabled={saveClient.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{saveClient.isPending ? "Saving…" : "Save"}</button>
          </>}
        >
          <div className="space-y-3 p-4">
            {!clientIsEdit && (
              <label className="block">
                <span className={labelCls}>Implementation</span>
                <select value={cImpl} onChange={(e) => { setCImpl(e.target.value); setCSettings({}); }} className={selectCls}>
                  {CLIENT_IMPL_OPTIONS.map((k) => <option key={k} value={k}>{k} ({implKinds[k]})</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className={labelCls}>Name</span>
              <input value={cName} onChange={(e) => setName(e.target.value)} placeholder="My SABnzbd" className={inputCls} />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={cEnabled} onChange={(e) => setCEnabled(e.target.checked)} className="h-4 w-4 accent-accent" /> Enabled
            </label>
            <label className="block">
              <span className={labelCls}>Priority</span>
              <input type="number" value={cPriority} onChange={(e) => setCPriority(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className={labelCls}>{cFields.host}</span>
              <input value={cSettings.host ?? ""} onChange={(e) => setCSettings((s) => ({ ...s, host: e.target.value }))} placeholder="http://192.168.1.10:8080" className={monoCls} />
            </label>
            {clientImpl === "sabnzbd" ? (
              <label className="block">
                <span className={labelCls}>API key</span>
                <SecretInput value={cSettings.apiKey ?? ""} onChange={(v) => setCSettings((s) => ({ ...s, apiKey: v }))} />
              </label>
            ) : (
              (cFields.extra ?? []).map((f) => (
                <label key={f.key} className="block">
                  <span className={labelCls}>{f.label}</span>
                  {f.secret ? (
                    <SecretInput value={cSettings[f.key] ?? ""} onChange={(v) => setCSettings((s) => ({ ...s, [f.key]: v }))} />
                  ) : (
                    <input value={cSettings[f.key] ?? ""} placeholder={f.def ?? ""} onChange={(e) => setCSettings((s) => ({ ...s, [f.key]: e.target.value }))} className={inputCls} />
                  )}
                </label>
              ))
            )}
            <div>
              <span className={labelCls}>Tags</span>
              <TagPicker value={cTags} onChange={setCTags} />
            </div>
            {testClientDraft.data && (
              <p className={`text-xs ${testClientDraft.data.ok ? "text-ok" : "text-err"}`}>
                {testClientDraft.data.ok ? `OK — ${testClientDraft.data.latencyMs}ms` : `Failed: ${testClientDraft.data.message}`}
              </p>
            )}
            {testClientDraft.isError && <p className={errTxt}>{testClientDraft.error instanceof Error ? testClientDraft.error.message : "Test failed"}</p>}
            {saveClient.isError && <p className={errTxt}>{saveClient.error instanceof Error ? saveClient.error.message : "Save failed"}</p>}
          </div>
        </Modal>
      )}

      {/* Media server modal */}
      {serverOpen && (
        <Modal
          title={serverIsEdit ? `Edit ${serverModal.editing?.name ?? "server"}` : "Add media server"}
          onClose={closeServer}
          footer={<>
            {serverIsEdit && serverModal.editing && (
              <button onClick={() => removeServer.mutate(serverModal.editing!.id)} className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err-bg">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            )}
            <button onClick={() => testServerDraft.mutate()} disabled={testServerDraft.isPending} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule disabled:opacity-50">{testServerDraft.isPending ? "Testing…" : "Test"}</button>
            <button onClick={closeServer} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
            <button onClick={() => saveServer.mutate()} disabled={saveServer.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{saveServer.isPending ? "Saving…" : "Save"}</button>
          </>}
        >
          <div className="space-y-3 p-4">
            {!serverIsEdit && (
              <label className="block">
                <span className={labelCls}>Type</span>
                <select value={sImpl} onChange={(e) => { setSImpl(e.target.value as never); setSKey(""); }} className={selectCls}>
                  <option value="jellyfin">Jellyfin</option><option value="plex">Plex</option>
                </select>
              </label>
            )}
            <label className="block">
              <span className={labelCls}>Name</span>
              <input value={sName} onChange={(e) => setSName(e.target.value)} placeholder="Plex#1" className={inputCls} />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={sEnabled} onChange={(e) => setSEnabled(e.target.checked)} className="h-4 w-4 accent-accent" /> Enabled
            </label>
            <label className="block">
              <span className={labelCls}>Host</span>
              <input value={sHost} onChange={(e) => setSHost(e.target.value)} placeholder={sImpl === "plex" ? "http://192.168.1.10:32400" : "http://192.168.1.10:8096"} className={monoCls} />
            </label>
            <label className="block">
              <span className={labelCls}>{SERVER_TOKEN_LABEL[serverModal.editing?.implementation ?? sImpl] ?? "API key"}</span>
              <SecretInput value={sKey} onChange={setSKey} />
            </label>
            {testServerDraft.data && (
              <p className={`text-xs ${testServerDraft.data.ok ? "text-ok" : "text-err"}`}>
                {testServerDraft.data.ok ? "OK" : `Failed: ${testServerDraft.data.message}`}
              </p>
            )}
            {testServerDraft.isError && <p className={errTxt}>{testServerDraft.error instanceof Error ? testServerDraft.error.message : "Test failed"}</p>}
            {saveServer.isError && <p className={errTxt}>{saveServer.error instanceof Error ? saveServer.error.message : "Save failed"}</p>}
          </div>
        </Modal>
      )}

      {/* Remote path mapping modal */}
      {mappingOpen && (
        <Modal
          title={mappingEdit ? "Edit remote path mapping" : "Add remote path mapping"}
          onClose={closeMapping}
          footer={<>
            {mappingEdit && (
              <button onClick={() => removeMapping.mutate(mappingEdit.id)} className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err-bg">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            )}
            <button onClick={closeMapping} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
            <button onClick={() => saveMapping.mutate()} disabled={saveMapping.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{saveMapping.isPending ? "Saving…" : "Save"}</button>
          </>}
        >
          <div className="space-y-3 p-4">
            {!mappingEdit && (
              <label className="block">
                <span className={labelCls}>Download client</span>
                <select value={rpmClientId} onChange={(e) => setRpmClientId(e.target.value)} className={selectCls}>
                  <option value="">Select…</option>
                  {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className={labelCls}>Remote path (as the client reports it)</span>
              <input value={rpmRemote} onChange={(e) => setRpmRemote(e.target.value)} placeholder="/downloads" className={monoCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Local path (as this app sees it)</span>
              <PathField value={rpmLocal} onChange={setRpmLocal} placeholder="/mnt/downloads" />
            </label>
            {saveMapping.isError && <p className={errTxt}>{saveMapping.error instanceof Error ? saveMapping.error.message : "Save failed"}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Secret field: in edit mode the API returns the [REDACTED] sentinel, shown masked with an
 *  "unchanged" placeholder. The sentinel stays in the draft until the user types a replacement,
 *  so an untouched secret round-trips unchanged and a new one replaces it. */
function SecretInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hidden = value === REDACTED;
  return (
    <input
      value={hidden ? "" : value}
      type="password"
      placeholder={hidden ? "unchanged" : ""}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}
