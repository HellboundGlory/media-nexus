// SPDX-License-Identifier: MIT
// Settings > Media Management (NAV-1 Phase 5, closes the rest of UNI-016): a real form against
// GET/PUT /system/config covering exactly the keys in packages/shared/src/settings.ts — naming
// templates, preferred protocol, download-stall timeout, free-space margin, recycle bin, and
// the downloads staging root. No config keys that don't exist are invented.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const numCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

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
  const [d, setD] = useState<Draft>(emptyDraft);
  useEffect(() => { if (cfg.data) setD(draftFromCfg(cfg.data)); }, [cfg.data]);

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

  const set = (k: keyof Draft, v: string) => setD((p) => ({ ...p, [k]: v }));

  return (
    <section className="rounded-xl border border-rule bg-surface p-4">
      <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Media Management</h3>
      <p className="mb-3 text-xs text-ink-dim">Naming templates, protocol preference, download/recycle behavior, and the downloads staging path. Saved via /system/config.</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Movie naming template</span>
          <input value={d.namingMovies} onChange={(e) => set("namingMovies", e.target.value)} className={monoCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Episode naming template</span>
          <input value={d.namingEpisodes} onChange={(e) => set("namingEpisodes", e.target.value)} className={monoCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Preferred protocol</span>
          <select value={d.preferredProtocol} onChange={(e) => set("preferredProtocol", e.target.value)} className={inputCls}>
            <option value="any">Any</option><option value="usenet">Usenet</option><option value="torrent">Torrent</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Download stall timeout (minutes)</span>
          <input type="number" value={d.downloadStallMinutes} onChange={(e) => set("downloadStallMinutes", e.target.value)} className={numCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Minimum free space (MB)</span>
          <input type="number" value={d.minimumFreeSpaceMb} onChange={(e) => set("minimumFreeSpaceMb", e.target.value)} className={numCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Recycle bin path</span>
          <input value={d.recycleBinPath} onChange={(e) => set("recycleBinPath", e.target.value)} placeholder="/data/recycle-bin (empty = delete)" className={monoCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Recycle bin retention (days)</span>
          <input type="number" value={d.recycleBinRetentionDays} onChange={(e) => set("recycleBinRetentionDays", e.target.value)} className={numCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Downloads staging root</span>
          <input value={d.downloadsPath} onChange={(e) => set("downloadsPath", e.target.value)} placeholder="/data/downloads" className={monoCls} />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{save.isPending ? "Saving…" : "Save"}</button>
        {save.isSuccess && <span className="text-xs text-ok">Saved.</span>}
      </div>
      {save.isError && <p className="mt-2 text-xs text-err">{save.error instanceof Error ? save.error.message : "Failed to save"}</p>}
    </section>
  );
}
