// SPDX-License-Identifier: MIT
// Indexers settings tab (UNI-018) — card grid with an add "card" and ONE add/edit modal,
// per the approved mockup. The modal saves via POST/PUT /indexers, tests the *draft* (the
// unsaved typed values) via POST /indexers/test, and manages per-indexer proxy + tag routing.
// The "Search & grab" panel is gone (decision 4); grab statistics and the custom-Cardigann
// definition form remain.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Plus, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { IndexerDef, IndexerRow, TagRow } from "../api/types";
import { Badge, ErrorState } from "../lib/ui";
import { Modal } from "../components/Modal";
import { ProviderCard } from "../components/ProviderCard";
import { TagPicker } from "../components/TagPicker";

interface CardigannSettingMeta {
  name: string;
  label?: string;
  type: string;
  default?: string | number | boolean;
  required?: boolean;
  options?: string[];
}

const REDACTED = "[REDACTED]";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = `${inputCls} font-mono`;
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";
const errTxt = "text-xs text-err";

interface ProxyDraft {
  enabled: boolean;
  type: "http" | "socks4" | "socks5";
  host: string;
  port: string;
  username: string;
  password: string;
  flareSolverr: boolean;
}

const emptyProxy: ProxyDraft = { enabled: false, type: "http", host: "", port: "8080", username: "", password: "", flareSolverr: false };

export default function Indexers() {
  const qc = useQueryClient();
  const [showCustom, setShowCustom] = useState(false);
  // modal state
  const [editing, setEditing] = useState<IndexerRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [modalDefKey, setModalDefKey] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState("25");
  const [settingsDraft, setSettingsDraft] = useState<Record<string, string | boolean>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [proxy, setProxy] = useState<ProxyDraft>(emptyProxy);
  const [showProxy, setShowProxy] = useState(false);
  // custom definition form
  const [customKey, setCustomKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [customProtocol, setCustomProtocol] = useState<"usenet" | "torrent">("torrent");
  const [customYaml, setCustomYaml] = useState("");

  const defs = useQuery({ queryKey: ["indexer-defs"], queryFn: () => api.get<(IndexerDef & { settingsSchema?: CardigannSettingMeta[] })[]>("/indexers/definitions") });
  const indexers = useQuery({ queryKey: ["indexers"], queryFn: () => api.get<IndexerRow[]>("/indexers") });
  const stats = useQuery({ queryKey: ["indexer-stats"], queryFn: () => api.get<any[]>("/indexers/statistics") });
  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: () => api.get<TagRow[]>("/tags") });
  const tagLookup = useMemo(() => new Map((tagsQuery.data ?? []).map((t) => [t.id, t])), [tagsQuery.data]);

  const open = editing !== null || adding;
  const isEdit = editing !== null;
  const selectedDef = defs.data?.find((d) => d.key === modalDefKey);

  // ---- actions ----
  const save = useMutation({
    mutationFn: async () => {
      const body = buildBody();
      if (isEdit && editing) return api.put(`/indexers/${editing.id}`, body);
      return api.post("/indexers", { ...body, definitionKey: modalDefKey, protocol: selectedDef?.protocol ?? "torrent" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["indexers"] });
      qc.invalidateQueries({ queryKey: ["indexer-stats"] });
      close();
    },
  });

  const testDraft = useMutation({
    mutationFn: () => api.post<{ ok: boolean; latencyMs: number; message: string }>("/indexers/test", buildBody()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); },
  });

  const testAll = useMutation({
    mutationFn: () => api.post<{ checked: number; ok: number; failed: number }>("/indexers/refresh-all"),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/indexers/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexers"] }); qc.invalidateQueries({ queryKey: ["indexer-stats"] }); close(); },
  });

  const createDefinition = useMutation({
    mutationFn: (body: { key: string; name: string; protocol: "usenet" | "torrent"; cardigannYml: string }) => api.post("/indexers/definitions", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["indexer-defs"] }); setShowCustom(false); setCustomYaml(""); setCustomKey(""); setCustomName(""); },
  });

  function buildBody(): Record<string, unknown> {
    const def = selectedDef;
    const settings: Record<string, unknown> = { ...Object.fromEntries(Object.entries(settingsDraft)) };
    if (def && def.implementation !== "cardigann") {
      settings.baseUrl = settings.baseUrl ?? "";
      settings.categories = [2000, 5000, 5010, 5020, 5030, 5040];
    }
    const proxyBody = {
      enabled: proxy.enabled,
      type: proxy.type,
      host: proxy.host,
      port: Number(proxy.port) || 0,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
      flareSolverr: proxy.flareSolverr,
    };
    return {
      ...(isEdit && editing ? { id: editing.id } : {}),
      // definitionKey/protocol/implementation drive the server's draft test AND identify the
      // definition at create time. The save PUT (updateIndexerSchema) strips them; the create
      // POST uses them.
      definitionKey: isEdit && editing ? editing.definitionKey : (def?.key ?? ""),
      protocol: isEdit && editing ? editing.protocol : (def?.protocol ?? "torrent"),
      implementation: isEdit && editing ? editing.implementation : (def?.implementation ?? ""),
      name,
      enabled,
      priority: Number(priority) || 25,
      settings,
      tags,
      proxy: proxy.enabled ? proxyBody : null,
    };
  }

  function openAdd() {
    setEditing(null);
    setAdding(true);
    setModalDefKey("");
    setName("");
    setEnabled(true);
    setPriority("25");
    setSettingsDraft({});
    setTags([]);
    setProxy(emptyProxy);
    setShowProxy(false);
  }

  function openEdit(row: IndexerRow) {
    setEditing(row);
    setAdding(false);
    setModalDefKey(row.definitionKey);
    setName(row.name);
    setEnabled(row.enabled);
    setPriority(String(row.priority ?? 25));
    const s: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(row.settings ?? {})) {
      if (typeof v === "boolean") s[k] = v;
      else s[k] = String(v);
    }
    setSettingsDraft(s);
    setTags(row.tags ?? []);
    const p = row.proxy;
    setProxy(p ? { enabled: p.enabled, type: p.type, host: p.host, port: String(p.port), username: p.username ?? "", password: p.password ?? "", flareSolverr: p.flareSolverr } : emptyProxy);
    setShowProxy(!!p);
  }

  function close() {
    setEditing(null);
    setAdding(false);
  }

  const testDraftError = testDraft.isError ? (testDraft.error instanceof Error ? testDraft.error.message : "Test failed") : null;
  const saveError = save.isError ? (save.error instanceof Error ? save.error.message : "Save failed") : null;

  return (
    <div className="space-y-6">
      {/* Indexers — one bordered section (toolbar header + custom form + grid), matching the
          Download Clients tab: both actions on a single header row. The section — including the
          'New custom (Cardigann)' toggle and its form — renders unconditionally so defining a
          custom Cardigann scraper stays reachable even when the indexer list query errors; only
          the grid is gated below. */}
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Indexers</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => setShowCustom((v) => !v)} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
                  {showCustom ? "Hide custom form" : "New custom (Cardigann)"}
                </button>
                <button onClick={() => testAll.mutate()} disabled={testAll.isPending} className="flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50">
                  <HeartPulse className="h-3.5 w-3.5" /> {testAll.isPending ? "Testing…" : "Test all"}
                </button>
              </div>
            </div>

            {showCustom && (
              <form
                className="mb-3 space-y-3 rounded-xl border border-rule bg-bg/40 p-4"
                onSubmit={(e) => { e.preventDefault(); createDefinition.mutate({ key: customKey, name: customName, protocol: customProtocol, cardigannYml: customYaml }); }}
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <label><span className={labelCls}>Key (slug)</span>
                    <input required value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="my-tracker" className={inputCls} /></label>
                  <label><span className={labelCls}>Name</span>
                    <input required value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="My Tracker" className={inputCls} /></label>
                  <label><span className={labelCls}>Protocol</span>
                    <select value={customProtocol} onChange={(e) => setCustomProtocol(e.target.value as never)} className={selectCls}>
                      <option value="torrent">Torrent</option><option value="usenet">Usenet</option>
                    </select></label>
                </div>
                <label><span className={labelCls}>Cardigann definition (YAML)</span>
                  <textarea required rows={7} value={customYaml} onChange={(e) => setCustomYaml(e.target.value)} className={`${inputCls} font-mono text-xs`} placeholder="name: MyTracker&#10;settings:&#10;  - name: baseUrl&#10;    type: text&#10;search:&#10;  rows:&#10;    selector: tr.row" />
                </label>
                <div className="flex items-center gap-2">
                  <button disabled={createDefinition.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
                    {createDefinition.isPending ? "Creating…" : "Create definition"}
                  </button>
                  {createDefinition.isError && <p className={errTxt}>{createDefinition.error instanceof Error ? createDefinition.error.message : "Invalid definition"}</p>}
                </div>
              </form>
            )}

            {indexers.isError ? <ErrorState error={indexers.error} onRetry={() => indexers.refetch()} /> : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {indexers.data?.map((i) => (
                  <ProviderCard
                    key={i.id}
                    name={i.name}
                    subLine={`${i.implementation} · ${i.protocol} · priority ${i.priority ?? 25}`}
                    enabled={i.enabled}
                    protocol={i.protocol}
                    status={i.status}
                    lastError={i.lastError}
                    tags={i.tags}
                    tagLookup={tagLookup}
                    onClick={() => openEdit(i)}
                  />
                ))}
                <button
                  type="button"
                  onClick={openAdd}
                  className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed border-rule bg-surface text-sm font-semibold uppercase tracking-wide text-ink-dim transition-colors hover:border-accent/50 hover:text-ink"
                >
                  <Plus className="h-4 w-4" /> Add
                </button>
              </div>
            )}
          </section>

      {!indexers.isError && (
        <section className="rounded-xl border border-rule bg-surface p-4">
          <h3 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Statistics (grabs)</h3>
            {stats.data?.length === 0 ? <p className="text-sm text-ink-dim">No data yet.</p> : (
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                {stats.data?.map((s) => (
                  <div key={s.id} className="rounded-lg border border-rule px-3 py-2">
                    <p className="truncate font-medium text-ink">{s.name}</p>
                    <p className="text-ink-dim">{s.grabs} grabs{s.lastGrabAt ? ` · last ${new Date(s.lastGrabAt).toLocaleDateString()}` : ""}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
      )}

      {open && (
        <Modal
          title={isEdit ? `Edit ${editing?.name ?? "indexer"}` : "Add indexer"}
          onClose={close}
          footer={
            <>
              {isEdit && editing && (
                <button
                  onClick={() => remove.mutate(editing.id)}
                  className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err-bg"
                >
                  <Trash2 className="h-4 w-4" /> Delete
                </button>
              )}
              <button onClick={() => testDraft.mutate()} disabled={testDraft.isPending} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule disabled:opacity-50">
                {testDraft.isPending ? "Testing…" : "Test"}
              </button>
              <button onClick={close} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          <div className="space-y-3 p-4">
            {isEdit ? (
              <label className="block">
                <span className={labelCls}>Definition</span>
                <input value={selectedDef?.name ?? editing?.definitionKey} disabled className={`${inputCls} cursor-not-allowed opacity-60`} />
                <p className="mt-1 text-xs text-ink-dim">An indexer's definition cannot be changed — that is a different provider.</p>
              </label>
            ) : (
              <label className="block">
                <span className={labelCls}>Definition</span>
                <select value={modalDefKey} onChange={(e) => { setModalDefKey(e.target.value); setSettingsDraft({}); }} className={selectCls}>
                  <option value="">Select…</option>
                  {defs.data?.map((d) => {
                    const cg = d.implementation === "cardigann" ? d.capabilities?.cardigannStatus : undefined;
                    const label = cg && !cg.supported ? " ⚠ unsupported" : (d.implementation === "cardigann" && !d.builtIn ? " (custom)" : "");
                    return <option key={d.key} value={d.key}>{d.name}{label} · {d.protocol}</option>;
                  })}
                </select>
              </label>
            )}
            {selectedDef?.implementation === "cardigann" && selectedDef.capabilities?.cardigannStatus && !selectedDef.capabilities.cardigannStatus.supported && (
              <p className="flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn-bg px-3 py-1.5 text-xs text-warn-ink">
                ⚠ Not usable in this build{selectedDef.capabilities.cardigannStatus.reasons?.length ? `: ${selectedDef.capabilities.cardigannStatus.reasons.join("; ")}` : ""}
              </p>
            )}
            <label className="block">
              <span className={labelCls}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My indexer" className={inputCls} />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-accent" /> Enabled
            </label>

            <SettingsFields
              def={selectedDef ?? null}
              editing={isEdit}
              settingsDraft={settingsDraft}
              setSettingsDraft={setSettingsDraft}
            />

            <label className="block">
              <span className={labelCls}>Priority</span>
              <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls} />
              <p className="mt-1 text-xs text-ink-dim">Lower number = higher priority (1 best). Used to order search results.</p>
            </label>

            <div>
              <span className={labelCls}>Tags</span>
              <TagPicker value={tags} onChange={setTags} />
            </div>

            <div className="rounded-lg border border-rule p-3">
              <button type="button" onClick={() => setShowProxy((v) => !v)} className="flex w-full items-center justify-between text-sm font-medium text-ink">
                <span className="flex items-center gap-2">Proxy {proxy.enabled && <Badge tone="ok">on</Badge>}</span>
                <span className="text-xs text-ink-dim">{showProxy ? "▾" : "▸"}</span>
              </button>
              {showProxy && (
                <div className="mt-3 space-y-3">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={proxy.enabled} onChange={(e) => setProxy({ ...proxy, enabled: e.target.checked })} className="h-4 w-4 accent-accent" /> Enable proxy
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className={labelCls}>Type</span>
                      <select value={proxy.type} onChange={(e) => setProxy({ ...proxy, type: e.target.value as never })} className={selectCls}>
                        <option value="http">HTTP</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelCls}>Port</span>
                      <input value={proxy.port} onChange={(e) => setProxy({ ...proxy, port: e.target.value })} className={inputCls} />
                    </label>
                  </div>
                  <label className="block">
                    <span className={labelCls}>Host</span>
                    <input value={proxy.host} onChange={(e) => setProxy({ ...proxy, host: e.target.value })} placeholder="proxy.example.com" className={monoCls} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className={labelCls}>Username</span>
                      <input value={proxy.username} onChange={(e) => setProxy({ ...proxy, username: e.target.value })} className={inputCls} />
                    </label>
                    <label className="block">
                      <span className={labelCls}>Password</span>
                      <SecretInput value={proxy.password} onChange={(v) => setProxy({ ...proxy, password: v })} />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={proxy.flareSolverr} onChange={(e) => setProxy({ ...proxy, flareSolverr: e.target.checked })} className="h-4 w-4 accent-accent" /> Route through FlareSolverr
                  </label>
                </div>
              )}
            </div>

            {testDraft.data && (
              <p className={`text-xs ${testDraft.data.ok ? "text-ok" : "text-err"}`}>
                {testDraft.data.ok ? `OK — ${testDraft.data.latencyMs}ms` : `Failed: ${testDraft.data.message}`}
              </p>
            )}
            {testDraftError && <p className={errTxt}>{testDraftError}</p>}
            {saveError && <p className={errTxt}>{saveError}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Secret field: in edit mode the API returns the [REDACTED] sentinel, which we show masked
 *  with an "unchanged" placeholder. The sentinel stays in the draft until the user types a
 *  replacement, so an untouched secret round-trips unchanged and a new one replaces it. */
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

/** Renders the implementation's settings fields. Cardigann renders from its definition's
 *  settingsSchema; newznab/torznab render the common fields. Secrets (apiKey/password/token /
 *  cardigann key-named fields) show masked when the stored value is [REDACTED] and round-trip
 *  the sentinel unless changed. */
function SettingsFields({
  def,
  editing,
  settingsDraft,
  setSettingsDraft,
}: {
  def: (IndexerDef & { settingsSchema?: CardigannSettingMeta[] }) | null;
  editing: boolean;
  settingsDraft: Record<string, string | boolean>;
  setSettingsDraft: (fn: (d: Record<string, string | boolean>) => Record<string, string | boolean>) => void;
}) {
  if (!def) return null;
  const set = (k: string, v: string | boolean) => setSettingsDraft((d) => ({ ...d, [k]: v }));

  if (def.implementation === "cardigann") {
    return (
      <>
        {(def.settingsSchema ?? []).map((s) => {
          const secret = s.name.toLowerCase().includes("key") || s.name.toLowerCase().includes("password") || s.name.toLowerCase().includes("token");
          const value = settingsDraft[s.name] ?? "";
          return (
            <label key={s.name} className="block">
              <span className={labelCls}>{s.label ?? s.name}</span>
              {s.type === "checkbox" ? (
                <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(s.name, e.target.checked)} className="h-4 w-4 accent-accent" />
              ) : secret && editing ? (
                <SecretInput value={String(value)} onChange={(v) => set(s.name, v)} />
              ) : (
                <input
                  type={s.type === "number" ? "number" : "text"}
                  value={String(value)}
                  onChange={(e) => set(s.name, e.target.value)}
                  placeholder={String(s.default ?? "")}
                  className={inputCls}
                />
              )}
            </label>
          );
        })}
      </>
    );
  }

  // non-cardigann (newznab / torznab)
  return (
    <>
      <label className="block">
        <span className={labelCls}>Base URL</span>
        <input value={String(settingsDraft.baseUrl ?? "")} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://indexer.example.com" className={monoCls} />
      </label>
      <label className="block">
        <span className={labelCls}>API key (optional)</span>
        <SecretInput value={String(settingsDraft.apiKey ?? "")} onChange={(v) => set("apiKey", v)} />
      </label>
    </>
  );
}
