// SPDX-License-Identifier: MIT
// BulkEditModal — UNI-020 bulk editor, the sibling of EditTitleModal for a multi-title selection.
// Every field is a <select> defaulting to a literal "No Change" option; only fields the admin
// actually touches are sent (the rest are omitted from the PATCH body entirely — no sentinel
// value is transmitted). Root Folder reuses the existing single-item limitation honestly: it only
// affects where NEW files import to, it does not move existing files.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { QualityProfile, RootFolder } from "../api/types";
import { Modal } from "./Modal";

const inputCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";

/** Only fields the admin touched are present — the "No Change" default is omitted, not sent. */
export interface BulkEditPatch {
  monitored?: boolean;
  qualityProfileId?: string;
  rootFolderPath?: string;
  minimumAvailability?: string;
  seriesType?: string;
}

export function BulkEditModal({
  mediaType,
  count = 0,
  onSave,
  onClose,
  busy,
}: {
  mediaType: "movie" | "series";
  count?: number;
  onSave: (patch: BulkEditPatch) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  // Root folders share AddTitleModal's ["root-folders"] query key, so React Query reuses the
  // cache — a hand-typed path would reintroduce the typo risk that (per AddTitleModal's own
  // comment) previously caused a real empty-rootFolderPath bug, and here it would misconfigure
  // every selected title at once instead of one.
  const rootFolders = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });
  const roots = rootFolders.data ?? [];
  const [monitored, setMonitored] = useState(""); // "" = No Change
  const [qualityProfileId, setQualityProfileId] = useState("");
  const [rootSel, setRootSel] = useState(""); // root folder id, "" = No Change
  const [minAvail, setMinAvail] = useState("");
  const [seriesType, setSeriesType] = useState("");

  const canSave = monitored !== "" || qualityProfileId !== "" || rootSel !== ""
    || (mediaType === "movie" ? minAvail !== "" : seriesType !== "");

  const submit = () => {
    const patch: BulkEditPatch = {};
    if (monitored !== "") patch.monitored = monitored === "true";
    if (qualityProfileId !== "") patch.qualityProfileId = qualityProfileId;
    if (rootSel !== "") {
      // Select carries the root-folder id; the bulk-edit API takes the path, so resolve it.
      const root = roots.find((r) => r.id === rootSel);
      if (root) patch.rootFolderPath = root.path;
    }
    if (mediaType === "movie" && minAvail !== "") patch.minimumAvailability = minAvail;
    if (mediaType === "series" && seriesType !== "") patch.seriesType = seriesType;
    onSave(patch);
  };

  const plural = mediaType === "movie" ? "movies" : "series";

  return (
    <Modal
      title={`Edit selected ${plural}`}
      onClose={onClose}
      footer={
        <>
          {count > 0 && <span className="mr-auto text-xs text-ink-dim">{count} {plural} selected</span>}
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button onClick={submit} disabled={busy || !canSave} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <label className="block">
          <span className={labelCls}>Monitored</span>
          <select value={monitored} onChange={(e) => setMonitored(e.target.value)} className={inputCls}>
            <option value="">No Change</option>
            <option value="true">Monitored</option>
            <option value="false">Unmonitored</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Quality Profile</span>
          <select value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value)} className={inputCls}>
            <option value="">No Change</option>
            {profiles.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {mediaType === "movie" ? (
          <label className="block">
            <span className={labelCls}>Minimum Availability</span>
            <select value={minAvail} onChange={(e) => setMinAvail(e.target.value)} className={inputCls}>
              <option value="">No Change</option>
              <option value="announced">Announced</option>
              <option value="in_cinemas">In Cinemas</option>
              <option value="released">Released</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
        ) : (
          <label className="block">
            <span className={labelCls}>Series Type</span>
            <select value={seriesType} onChange={(e) => setSeriesType(e.target.value)} className={inputCls}>
              <option value="">No Change</option>
              <option value="standard">Standard</option>
              <option value="daily">Daily</option>
              <option value="anime">Anime</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className={labelCls}>Root Folder</span>
          <select value={rootSel} onChange={(e) => setRootSel(e.target.value)} className={inputCls}>
            <option value="">No Change</option>
            {roots.map((r) => <option key={r.id} value={r.id}>{r.name || r.path}{r.isDefault ? " (default)" : ""}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-dim">Only updates where new files import to. Does NOT move existing files.</p>
        </label>
      </div>
    </Modal>
  );
}
