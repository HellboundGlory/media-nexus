// SPDX-License-Identifier: MIT
// AddTitleModal — the reusable "configure & add" modal (QUALITYPROFILES-1 / UNI-014) used by
// every add path (Discover, quick-add on Movies/Series, Library Import). Shows the title's
// poster/overview (or placeholders) and the add options: monitored, root folder, quality
// profile, minimum availability (movie) / series type (series), and comma-separated tags. Root
// folder and quality profile default to the configured isDefault rows (and the root folder
// default is genuinely sent when the user leaves the picker untouched — resolved from
// `rootSel || defaultRoot`, see submit). When `lockedRootFolderPath` is passed (Library Import
// already knows the on-disk path from its folder scan) the root folder renders as read-only
// text instead of a picker. `isPending`/`error` let callers surface their mutation state the
// same way QualityProfiles/CustomFormats do. onSubmit receives the assembled create body.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Film, Tv, Check } from "lucide-react";
import { api } from "../api/client";
import type { RootFolder, QualityProfile } from "../api/types";
import { Modal } from "./Modal";

export type MinimumAvailability = "announced" | "in_cinemas" | "released" | "deleted";
export type SeriesType = "standard" | "daily" | "anime";

export interface AddTitleBody {
  /** Omitted (undefined) when no profile is selected — the create schemas accept an absent
   *  (not null) qualityProfileId, so we must not send `null` on create paths. */
  qualityProfileId?: string | null;
  rootFolderPath: string;
  monitored: boolean;
  tags: string[];
  minimumAvailability?: MinimumAvailability;
  seriesType?: SeriesType;
}

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function AddTitleModal({
  mediaType,
  title,
  posterUrl,
  overview,
  lockedRootFolderPath,
  isPending,
  error,
  /** Hide Minimum Availability (Discover movie path) — the backend's smart TMDB-date-derived
   *  default is deliberately non-overridable there, so rendering an editable field would be a
   *  silent no-op. Series/Movies quick-add and Library Import keep it editable. */
  lockMinimumAvailability,
  onSubmit,
  onClose,
}: {
  mediaType: "movie" | "series";
  title: string;
  posterUrl?: string | null;
  overview?: string | null;
  lockedRootFolderPath?: string;
  isPending?: boolean;
  error?: unknown;
  lockMinimumAvailability?: boolean;
  onSubmit: (body: AddTitleBody) => void;
  onClose: () => void;
}) {
  const rootFolders = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const [monitored, setMonitored] = useState(true);
  const [rootSel, setRootSel] = useState("");
  const [profileSel, setProfileSel] = useState("");
  const [minAvail, setMinAvail] = useState<MinimumAvailability>("released");
  const [seriesType, setSeriesType] = useState<SeriesType>("standard");
  const [tags, setTags] = useState("");

  const roots = rootFolders.data ?? [];
  const profilesList = profiles.data ?? [];
  // Default selection: the configured default row, falling back to the first row so the pickers
  // are never empty on a fresh install (the seed guarantees a real default anyway).
  const defaultRoot = roots.find((r) => r.isDefault)?.id ?? roots[0]?.id ?? "";
  const defaultProfile = profilesList.find((p) => p.isDefault)?.id ?? profilesList[0]?.id ?? "";

  const submit = () => {
    // Resolve the root from `rootSel || defaultRoot`, NOT bare `rootSel`: a user who leaves the
    // picker on its pre-filled default has an untouched `rootSel` (""), and without the fallback
    // the default would never be sent (BUG fixed in review — reintroduced empty rootFolderPath).
    const selectedRoot = roots.find((r) => r.id === (rootSel || defaultRoot));
    const body: AddTitleBody = {
      // undefined (not null) when nothing is selected — the create schemas reject null here.
      qualityProfileId: profileSel || defaultProfile || undefined,
      rootFolderPath: lockedRootFolderPath ?? selectedRoot?.path ?? "",
      monitored,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    };
    if (mediaType === "movie" && !lockMinimumAvailability) body.minimumAvailability = minAvail;
    else if (mediaType === "series") body.seriesType = seriesType;
    onSubmit(body);
  };

  const singular = mediaType === "movie" ? "movie" : "series";

  return (
    <Modal
      title={`Add ${singular}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button
            onClick={submit}
            disabled={!title || !profilesList.length || isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> {isPending ? "Adding…" : "Add"}
          </button>
        </>
      }
    >
      {error ? (
        <div className="border-b border-rule bg-err-bg px-4 py-2 text-xs text-err-ink">
          {error instanceof Error ? error.message : "Add failed"}
        </div>
      ) : null}

      <div className="space-y-4 p-4">
        <div className="flex gap-3">
          <div className="flex h-32 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-rule bg-track">
            {posterUrl ? (
              <img src={posterUrl} alt={title} className="h-full w-full object-cover" />
            ) : (
              <span className="text-ink-dim">{mediaType === "movie" ? <Film className="h-6 w-6" /> : <Tv className="h-6 w-6" />}</span>
            )}
          </div>
          <div className="min-w-0">
            <p className="font-display text-base font-semibold uppercase tracking-[0.04em] text-ink">{title}</p>
            {overview && <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-dim">{overview}</p>}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-dim">
          <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} className="h-4 w-4" />
          Monitored
        </label>

        {lockedRootFolderPath ? (
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">Root Folder <span className="text-warn-ink">(locked by import scan)</span></span>
            <span className="block truncate rounded-lg border border-rule bg-bg px-3 py-1.5 font-mono text-xs text-ink-dim">{lockedRootFolderPath}</span>
          </label>
        ) : (
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">Root Folder</span>
            <select value={rootSel || defaultRoot} onChange={(e) => setRootSel(e.target.value)} className={selectCls}>
              {roots.map((r) => <option key={r.id} value={r.id}>{r.name || r.path}{r.isDefault ? " (default)" : ""}</option>)}
            </select>
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Quality Profile</span>
          <select value={profileSel || defaultProfile} onChange={(e) => setProfileSel(e.target.value)} className={selectCls}>
            {profilesList.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? " (default)" : ""}</option>)}
          </select>
        </label>

        {mediaType === "movie" && !lockMinimumAvailability && (
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">Minimum Availability</span>
            <select value={minAvail} onChange={(e) => setMinAvail(e.target.value as MinimumAvailability)} className={selectCls}>
              <option value="announced">Announced</option>
              <option value="in_cinemas">In Cinemas</option>
              <option value="released">Released</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
        )}

        {mediaType === "series" && (
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">Series Type</span>
            <select value={seriesType} onChange={(e) => setSeriesType(e.target.value as SeriesType)} className={selectCls}>
              <option value="standard">Standard</option>
              <option value="daily">Daily</option>
              <option value="anime">Anime</option>
            </select>
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Tags (comma-separated)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="favorite, 4k" className={inputCls} />
        </label>

        {!profilesList.length && <p className="text-xs text-warn-ink">No quality profiles configured yet — create one under Settings → Quality Profiles.</p>}
      </div>
    </Modal>
  );
}
