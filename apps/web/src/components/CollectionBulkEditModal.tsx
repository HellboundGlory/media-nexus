// SPDX-License-Identifier: MIT
// CollectionBulkEditModal — UNI-021 bulk editor for Collections, following the UNI-020
// BulkEditModal pattern ("No Change" sentinel; only touched fields are sent). Fields differ from
// movie/series bulk edit: Monitor / Quality Profile / Minimum Availability / Root Folder / Search
// on Add (no Series Type).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { QualityProfile, RootFolder } from "../api/types";
import { Modal } from "./Modal";

const selectCls = "w-full rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";

export interface CollectionBulkEditPatch {
  monitored?: boolean;
  qualityProfileId?: string;
  rootFolderPath?: string;
  minimumAvailability?: string;
  searchOnAdd?: boolean;
}

export function CollectionBulkEditModal({
  count = 0,
  onSave,
  onClose,
  busy,
}: {
  count?: number;
  onSave: (patch: CollectionBulkEditPatch) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });
  const rootsQ = useQuery({ queryKey: ["root-folders"], queryFn: () => api.get<RootFolder[]>("/root-folders") });
  const roots = rootsQ.data ?? [];
  const [monitored, setMonitored] = useState("");
  const [qualityProfileId, setQualityProfileId] = useState("");
  const [rootSel, setRootSel] = useState("");
  const [minAvailability, setMinAvailability] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState("");

  const canSave = monitored !== "" || qualityProfileId !== "" || rootSel !== "" || minAvailability !== "" || searchOnAdd !== "";

  const submit = () => {
    const patch: CollectionBulkEditPatch = {};
    if (monitored !== "") patch.monitored = monitored === "true";
    if (qualityProfileId !== "") patch.qualityProfileId = qualityProfileId;
    if (rootSel !== "") {
      const root = roots.find((r) => r.id === rootSel);
      if (root) patch.rootFolderPath = root.path;
    }
    if (minAvailability !== "") patch.minimumAvailability = minAvailability;
    if (searchOnAdd !== "") patch.searchOnAdd = searchOnAdd === "true";
    onSave(patch);
  };

  return (
    <Modal
      title="Edit selected collections"
      onClose={onClose}
      footer={
        <>
          {count > 0 && <span className="mr-auto text-xs text-ink-dim">{count} collections selected</span>}
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button onClick={submit} disabled={busy || !canSave} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <label className="block">
          <span className={labelCls}>Monitor</span>
          <select value={monitored} onChange={(e) => setMonitored(e.target.value)} className={selectCls}>
            <option value="">No Change</option>
            <option value="true">Monitored</option>
            <option value="false">Unmonitored</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Quality Profile</span>
          <select value={qualityProfileId} onChange={(e) => setQualityProfileId(e.target.value)} className={selectCls}>
            <option value="">No Change</option>
            {profiles.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Minimum Availability</span>
          <select value={minAvailability} onChange={(e) => setMinAvailability(e.target.value)} className={selectCls}>
            <option value="">No Change</option>
            <option value="announced">Announced</option>
            <option value="in_cinemas">In Cinemas</option>
            <option value="released">Released</option>
            <option value="deleted">Deleted</option>
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Root Folder</span>
          <select value={rootSel} onChange={(e) => setRootSel(e.target.value)} className={selectCls}>
            <option value="">No Change</option>
            {roots.map((r) => <option key={r.id} value={r.id}>{r.name || r.path}{r.isDefault ? " (default)" : ""}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Search on Add</span>
          <select value={searchOnAdd} onChange={(e) => setSearchOnAdd(e.target.value)} className={selectCls}>
            <option value="">No Change</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}
