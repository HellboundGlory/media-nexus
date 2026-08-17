// SPDX-License-Identifier: MIT
// Settings > Media Management (NAV-1 Phase 5 + UNI-018): a real form against
// GET/PUT /system/config covering exactly the keys in packages/shared/src/settings.ts — naming
// templates, preferred protocol, download-stall timeout, free-space margin, recycle bin, and
// the downloads staging root. Plus the root-folders table (moved here upstream-style, UNI-018):
// default star, path, name, free space, status, Edit, delete — Edit renames only (path is not
// editable; the update schema does not accept it).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import type { RootFolder } from "../../api/types";
import { Badge, EmptyState } from "../../lib/ui";
import { Modal } from "../../components/Modal";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const numCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";
const errTxt = "text-xs text-err";

function formatBytes(n: number | null): string {
  if (n === null || n < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

interface Draft {
  namingMovies: string;
  namingEpisodes: string;
  preferredProtocol: string;
  downloadStallMinutes: string;
  minimumFreeSpaceMb: string;
  recycleBinPath: string;
  recycleBinRetentionDays: string;
  downloadsPath: string;
}

const emptyDraft: Draft = { namingMovies: "", namingEpisodes: "", preferredProtocol: "any", downloadStallMinutes: "", minimumFreeSpaceMb: "", recycleBinPath: "", recycleBinRetentionDays: "", downloadsPath: "" };

function draftFromCfg(c: Record<string, unknown> | undefined): Draft {
  if (!c) return emptyDraft;
  const naming = (c["media.naming"] ?? {}) as Record<string, unknown>;
  return {
    namingMovies: String(naming.movies ?? ""),
    namingEpisodes: String(naming.episodes ?? ""),
    preferredProtocol: String(c["media.preferredProtocol"] ?? "any"),
    downloadStallMinutes: c["media.downloadStallMinutes"] != null ? String(c["media.downloadStallMinutes"]) : "",
    minimumFreeSpaceMb: c["media.minimumFreeSpaceMb"] != null ? String(c["media.minimumFreeSpaceMb"]) : "",
    recycleBinPath: String(c["media.recycleBinPath"] ?? ""),
    recycleBinRetentionDays: c["media.recycleBinRetentionDays"] != null ? String(c["media.recycleBinRetentionDays"]) : "",
    downloadsPath: String(c["paths.downloads"] ?? ""),
  };
}

export function MediaManagementTab() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const rootFolders = useQuery<RootFolder[]>({ queryKey: ["root-folders"], queryFn: () => api.get("/root-folders") });
  const [d, setD] = useState<Draft>(emptyDraft);
  useEffect(() => { if (cfg.data) setD(draftFromCfg(cfg.data)); }, [cfg.data]);

  // root folder add / edit modal
  const [editingRoot, setEditingRoot] = useState<RootFolder | null>(null);
  const [addingRoot, setAddingRoot] = useState(false);
  const [newRootPath, setNewRootPath] = useState("");
  const [newRootName, setNewRootName] = useState("");
  const [editName, setEditName] = useState("");

  const save = useMutation({
    mutationFn: () => api.put("/system/config", {
      // media.naming is ONE nested key per settings.ts's namingSchema — sending the flat
      // "media.naming.movies"/"media.naming.episodes" forms gets the whole PUT rejected because
      // putConfig() validates every key against the flat key list BEFORE applying anything.
      "media.naming": { movies: d.namingMovies, episodes: d.namingEpisodes },
      "media.preferredProtocol": d.preferredProtocol,
      "media.downloadStallMinutes": Number(d.downloadStallMinutes || 0),
      "media.minimumFreeSpaceMb": Number(d.minimumFreeSpaceMb || 0),
      "media.recycleBinPath": d.recycleBinPath,
      "media.recycleBinRetentionDays": Number(d.recycleBinRetentionDays || 0),
      "paths.downloads": d.downloadsPath,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const addRoot = useMutation({
    mutationFn: () => api.post<RootFolder>("/root-folders", { path: newRootPath, name: newRootName, isDefault: (rootFolders.data?.length ?? 0) === 0 }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["root-folders"] }); setNewRootPath(""); setNewRootName(""); setAddingRoot(false); },
  });
  const saveRoot = useMutation({
    mutationFn: (id: string) => api.put(`/root-folders/${id}`, { name: editName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["root-folders"] }); setEditingRoot(null); },
  });
  const removeRoot = useMutation({
    mutationFn: (id: string) => api.del(`/root-folders/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["root-folders"] }),
  });
  const setDefaultRoot = useMutation({
    mutationFn: (id: string) => api.put(`/root-folders/${id}`, { isDefault: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["root-folders"] }),
  });

  const openEditRoot = (rf: RootFolder) => { setEditingRoot(rf); setEditName(rf.name || rf.path); };
  const set = (k: keyof Draft, v: string) => setD((p) => ({ ...p, [k]: v }));
  const addError = addRoot.isError ? (addRoot.error instanceof Error ? addRoot.error.message : "Add failed") : null;
  const saveRootError = saveRoot.isError ? (saveRoot.error instanceof Error ? saveRoot.error.message : "Save failed") : null;
  const removeError = removeRoot.isError ? (removeRoot.error instanceof Error ? removeRoot.error.message : "Remove failed") : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Media Management</h3>
        <p className="mb-3 text-xs text-ink-dim">Naming templates, protocol preference, download/recycle behavior, and the downloads staging path. Saved via /system/config.</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Movie naming template</span>
            <input value={d.namingMovies} onChange={(e) => set("namingMovies", e.target.value)} className={monoCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Episode naming template</span>
            <input value={d.namingEpisodes} onChange={(e) => set("namingEpisodes", e.target.value)} className={monoCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Preferred protocol</span>
            <select value={d.preferredProtocol} onChange={(e) => set("preferredProtocol", e.target.value)} className={inputCls}>
              <option value="any">Any</option><option value="usenet">Usenet</option><option value="torrent">Torrent</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Download stall timeout (minutes)</span>
            <input type="number" value={d.downloadStallMinutes} onChange={(e) => set("downloadStallMinutes", e.target.value)} className={numCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Minimum free space (MB)</span>
            <input type="number" value={d.minimumFreeSpaceMb} onChange={(e) => set("minimumFreeSpaceMb", e.target.value)} className={numCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Recycle bin path</span>
            <input value={d.recycleBinPath} onChange={(e) => set("recycleBinPath", e.target.value)} placeholder="/data/recycle-bin (empty = delete)" className={monoCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Recycle bin retention (days)</span>
            <input type="number" value={d.recycleBinRetentionDays} onChange={(e) => set("recycleBinRetentionDays", e.target.value)} className={numCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Downloads staging root</span>
            <input value={d.downloadsPath} onChange={(e) => set("downloadsPath", e.target.value)} placeholder="/data/downloads" className={monoCls} />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{save.isPending ? "Saving…" : "Save"}</button>
          {save.isSuccess && <span className="text-xs text-ok">Saved.</span>}
        </div>
        {save.isError && <p className="mt-2 text-xs text-err">{save.error instanceof Error ? save.error.message : "Failed to save"}</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Root folders</h3>
          <button onClick={() => setAddingRoot(true)} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            <Plus className="h-3.5 w-3.5" /> Add root folder
          </button>
        </div>
        <p className="mb-3 text-xs text-ink-dim">Where movies and series are stored. The starred folder is the default for a new title with no explicit choice.</p>
        {rootFolders.data?.length === 0 ? (
          <EmptyState title="No root folders" hint="Add one below — movies/series added without an explicit path fall back to the default." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Default</th><th className="px-3 py-2">Path</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Free space</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rootFolders.data?.map((rf) => (
                  <tr key={rf.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setDefaultRoot.mutate(rf.id)}
                        disabled={rf.isDefault}
                        className={`rounded p-1 ${rf.isDefault ? "cursor-default text-accent" : "text-ink-dim hover:bg-rule hover:text-accent"}`}
                        title={rf.isDefault ? "Default root folder" : "Make default"}
                      >
                        <Star className={`h-4 w-4 ${rf.isDefault ? "fill-accent" : ""}`} />
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink">{rf.path}</td>
                    <td className="px-3 py-2 font-medium text-ink">{rf.name || rf.path}</td>
                    <td className="px-3 py-2 text-xs text-ink-dim">{formatBytes(rf.freeBytes)} free of {formatBytes(rf.totalBytes)}</td>
                    <td className="px-3 py-2"><Badge tone={rf.accessible ? "ok" : "danger"}>{rf.accessible ? "accessible" : "unreachable"}</Badge></td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => openEditRoot(rf)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                        <button onClick={() => removeRoot.mutate(rf.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(removeError || addError) && <p className="mt-2 text-xs text-err">{removeError ?? addError}</p>}
      </section>

      {/* Add root folder modal */}
      {addingRoot && (
        <Modal title="Add root folder" onClose={() => setAddingRoot(false)} footer={
          <>
            <button onClick={() => setAddingRoot(false)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
            <button onClick={() => addRoot.mutate()} disabled={!newRootPath || addRoot.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{addRoot.isPending ? "Adding…" : "Add"}</button>
          </>
        }>
          <div className="space-y-3 p-4">
            <label className="block">
              <span className={labelCls}>Path (must exist on disk)</span>
              <input value={newRootPath} onChange={(e) => setNewRootPath(e.target.value)} placeholder="/data/media" className={monoCls} />
            </label>
            <label className="block">
              <span className={labelCls}>Name (optional)</span>
              <input value={newRootName} onChange={(e) => setNewRootName(e.target.value)} placeholder="Movies" className={inputCls} />
            </label>
            {addError && <p className={errTxt}>{addError}</p>}
          </div>
        </Modal>
      )}

      {/* Rename root folder modal — path is deliberately NOT editable */}
      {editingRoot && (
        <Modal
          title={`Rename ${editingRoot.name || editingRoot.path}`}
          onClose={() => setEditingRoot(null)}
          footer={
            <>
              <button onClick={() => removeRoot.mutate(editingRoot.id)} className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err hover:bg-err-bg">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
              <button onClick={() => setEditingRoot(null)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
              <button onClick={() => saveRoot.mutate(editingRoot.id)} disabled={saveRoot.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{saveRoot.isPending ? "Saving…" : "Save"}</button>
            </>
          }
        >
          <div className="space-y-3 p-4">
            <label className="block">
              <span className={labelCls}>Path</span>
              <input value={editingRoot.path} disabled className={`${monoCls} cursor-not-allowed opacity-60`} />
              <p className="mt-1 text-xs text-ink-dim">A folder's path is fixed at creation. Repointing it would need a move/rescan workflow, not a rename.</p>
            </label>
            <label className="block">
              <span className={labelCls}>Name</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} className={inputCls} />
            </label>
            {saveRootError && <p className={errTxt}>{saveRootError}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
