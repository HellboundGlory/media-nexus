// SPDX-License-Identifier: MIT
// EditFileModal — metadata-only editing of a single media_file row (FILEMGMT-1): Quality,
// Languages and Release Group, PUT to /media-files/:id. No filesystem operation. Reuses the
// InteractiveSearchModal shell and the AutoTags/ReleaseProfiles labeled-input styling.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import { api } from "../../api/client";
import type { MediaFileRow } from "../../api/types";

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function EditFileModal({ file, onClose, onSaved }: { file: MediaFileRow; onClose: () => void; onSaved: () => void }) {
  const [source, setSource] = useState(file.quality?.source ?? "");
  const [resolution, setResolution] = useState(file.quality?.resolution ?? "");
  const [edition, setEdition] = useState(file.quality?.edition ?? "");
  const [languages, setLanguages] = useState(file.languages.join(", "));
  const [releaseGroup, setReleaseGroup] = useState(file.releaseGroup ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.put(`/media-files/${file.id}`, {
        quality: { source, resolution, edition },
        languages: languages.split(",").map((s) => s.trim()).filter(Boolean),
        releaseGroup: releaseGroup.trim() || null,
      }),
    onSuccess: () => { onSaved(); onClose(); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Edit File</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
            <FileText className="h-4 w-4 shrink-0 text-ink-dim" />
            <span className="truncate font-mono text-xs text-ink" title={file.relativePath}>{file.relativePath}</span>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-dim">Quality</span>
            <div className="flex gap-2">
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="source" className={`${inputCls} basis-1/3`} />
              <input value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="resolution" className={`${inputCls} basis-1/3`} />
              <input value={edition} onChange={(e) => setEdition(e.target.value)} placeholder="edition" className={`${inputCls} basis-1/3`} />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-dim">Languages (comma-separated)</span>
            <input value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="en, fr" className={inputCls} />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-dim">Release Group</span>
            <input value={releaseGroup} onChange={(e) => setReleaseGroup(e.target.value)} placeholder="e.g. FGT" className={inputCls} />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
        {save.isError && <p className="px-4 pb-3 text-xs text-err">{save.error instanceof Error ? save.error.message : "Failed to save"}</p>}
      </div>
    </div>
  );
}
