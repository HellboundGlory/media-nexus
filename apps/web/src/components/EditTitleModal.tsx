// SPDX-License-Identifier: MIT
// EditTitleModal — the reusable single-column "Edit Movie / Edit Series" modal
// (QUALITYPROFILES-1 / UNI-014), pre-filled from the current title and PUT on save. Fields per
// media type: movie = Monitored, Minimum Availability, Quality Profile, Path, Tags; series =
// Monitored, Quality Profile, Series Type, Path, Tags. Path is a plain text input — no
// filesystem-browse picker (that's a separate finding, UNI-012). Deliberately NOT included:
// Sonarr's "Monitor New Seasons" / "Use Season Folder" (updateSeriesSchema doesn't accept them
// yet — no fake controls for capabilities without a backend).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "../api/client";
import type { QualityProfile } from "../api/types";
import { Modal } from "./Modal";
import type { MinimumAvailability, SeriesType } from "./AddTitleModal";

export interface EditTitleInitial {
  monitored: boolean;
  qualityProfileId: string | null;
  rootFolderPath: string;
  minimumAvailability?: MinimumAvailability;
  seriesType?: SeriesType;
  tags: string[];
}

export interface EditTitleBody {
  monitored?: boolean;
  qualityProfileId?: string | null;
  rootFolderPath?: string;
  minimumAvailability?: MinimumAvailability;
  seriesType?: SeriesType;
  tags?: string[];
}

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function EditTitleModal({
  mediaType,
  initial,
  onSave,
  onClose,
}: {
  mediaType: "movie" | "series";
  initial: EditTitleInitial;
  onSave: (body: EditTitleBody) => void;
  onClose: () => void;
}) {
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const profilesList = profiles.data ?? [];

  const [monitored, setMonitored] = useState(initial.monitored);
  const [profileSel, setProfileSel] = useState(initial.qualityProfileId ?? "");
  const [path, setPath] = useState(initial.rootFolderPath ?? "");
  const [minAvail, setMinAvail] = useState<MinimumAvailability>(initial.minimumAvailability ?? "released");
  const [seriesType, setSeriesType] = useState<SeriesType>(initial.seriesType ?? "standard");
  const [tags, setTags] = useState((initial.tags ?? []).join(", "));

  const singular = mediaType === "movie" ? "movie" : "series";

  const submit = () => {
    const body: EditTitleBody = {
      monitored,
      qualityProfileId: profileSel || null,
      rootFolderPath: path,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
    };
    if (mediaType === "movie") body.minimumAvailability = minAvail;
    else body.seriesType = seriesType;
    onSave(body);
  };

  return (
    <Modal
      title={`Edit ${singular}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button
            onClick={submit}
            disabled={!profilesList.length}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Save
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm text-ink-dim">
          <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} className="h-4 w-4" />
          Monitored
        </label>

        {mediaType === "movie" && (
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

        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Quality Profile</span>
          <select value={profileSel} onChange={(e) => setProfileSel(e.target.value)} className={selectCls}>
            <option value="">None</option>
            {profilesList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

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
          <span className="mb-1 block text-xs text-ink-dim">Path</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/data/media/title" className={`${inputCls} font-mono`} />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Tags (comma-separated)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="favorite, 4k" className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}
