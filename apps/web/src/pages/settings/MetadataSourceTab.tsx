// SPDX-License-Identifier: MIT
// Settings > Metadata Source (NAV-1 Phase 4, closes UNI-023): the TMDB key form relocated from
// System plus the previously-UI-less TheTVDB key/baseUrl fields (used by the D8 numbering
// backfill). All through the generic PUT /system/config. Attribution copy retained.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { api } from "../../api/client";

const monoCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function MetadataSourceTab() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const [tmdb, setTmdb] = useState("");
  const [tvdbKey, setTvdbKey] = useState("");
  const [tvdbBase, setTvdbBase] = useState("");
  const [lsaved, setLsaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => api.put("/system/config", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); setLsaved(true); setTimeout(() => setLsaved(false), 1500); },
  });

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><Database className="h-4 w-4" /> TMDB</h3>
        <p className="mb-3 text-xs text-ink-dim">Powers Discover and per-title metadata refresh. Get a free API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="underline text-accent">themoviedb.org/settings/api</a>.</p>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">TMDB API key</span>
          <div className="flex gap-2">
            <input value={tmdb} onChange={(e) => setTmdb(e.target.value)} placeholder={cfg.data?.["metadata.tmdbApiKey"] ? "•••••••••••••••• (set — paste to replace)" : "TMDB API key"} className={monoCls} />
            <button onClick={() => tmdb.trim() && save.mutate({ "metadata.tmdbApiKey": tmdb.trim() })} disabled={save.isPending || !tmdb.trim()} className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">Save</button>
          </div>
        </label>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">TheTVDB</h3>
        <p className="mb-3 text-xs text-ink-dim">
          Provides series absolute/scene episode numbering backfill. Leave blank to use the shared proxy.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">TVDB API key</span>
            <div className="flex gap-2">
              <input value={tvdbKey} onChange={(e) => setTvdbKey(e.target.value)} placeholder="Optional — blank uses shared proxy" className={monoCls} />
              <button onClick={() => save.mutate({ "metadata.tvdbApiKey": tvdbKey.trim() })} disabled={save.isPending} className="shrink-0 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink hover:bg-rule">Save</button>
            </div>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">TVDB base URL</span>
            <div className="flex gap-2">
              <input value={tvdbBase} onChange={(e) => setTvdbBase(e.target.value)} placeholder="https://api4.thetvdb.com/v4" className={monoCls} />
              <button onClick={() => save.mutate({ "metadata.tvdbBaseUrl": tvdbBase.trim() })} disabled={save.isPending} className="shrink-0 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink hover:bg-rule">Save</button>
            </div>
          </label>
        </div>
        {lsaved && <p className="mt-2 text-xs text-ok">Saved.</p>}
      </section>

      <p className="text-xs text-ink-dim">Powered by TMDB (movies &amp; series metadata) — episode numbering via TheTVDB.</p>
    </div>
  );
}
