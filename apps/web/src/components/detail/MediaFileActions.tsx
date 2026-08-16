// SPDX-License-Identifier: MIT
// MediaFileActions — the per-file row actions shared by the movie and series Files tables
// (FILEMGMT-1): a hover MediaInfo popover (copying SeasonPill's group-hover pattern — the
// caller must keep this out of any `overflow-hidden` container), an Edit button opening the
// EditFileModal, and a Delete button with a small confirm modal hitting DELETE /media-files/:id.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileText, Info, Pencil, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { MediaFileRow } from "../../api/types";
import { EditFileModal } from "./EditFileModal";

export function MediaFileActions({
  file,
  onChanged,
}: {
  file: MediaFileRow;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const removeFile = useMutation({
    mutationFn: () => api.del(`/media-files/${file.id}`),
    onSuccess: () => { setConfirming(false); onChanged(); },
  });

  const info = file.mediaInfo;

  return (
    <span className="flex items-center gap-1">
      {/* Hover MediaInfo popover — same group/group-hover mechanics as SeasonPill. */}
      <span className="group relative inline-flex">
        <button className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Media info" aria-label="Media info">
          <Info className="h-3.5 w-3.5" />
        </button>
        <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-60 whitespace-normal rounded-lg border border-rule bg-surface px-3 py-2 text-xs shadow-lg group-hover:block">
          {info ? (
            <span className="block space-y-0.5 text-ink-dim">
              <span className="block"><span className="font-semibold text-ink">Video:</span> {info.videoCodec ?? "\u2014"}{info.resolution ? ` · ${info.resolution}` : ""}</span>
              <span className="block"><span className="font-semibold text-ink">Audio:</span> {info.audioCodec ?? "\u2014"}{info.audioChannels ? ` · ${info.audioChannels}ch` : ""}</span>
              <span className="block"><span className="font-semibold text-ink">Runtime:</span> {info.runtimeSeconds ? `${Math.round(info.runtimeSeconds / 60)}m` : "\u2014"}</span>
              <span className="block"><span className="font-semibold text-ink">Subtitles:</span> {info.subtitles?.length ? info.subtitles.map((s) => s.language ?? "?").join(", ") : "\u2014"}</span>
            </span>
          ) : (
            <span className="text-ink-dim">No media info yet — refresh metadata to probe the file.</span>
          )}
        </span>
      </span>

      <button onClick={() => setEditing(true)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Edit file" aria-label="Edit file">
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => setConfirming(true)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" title="Delete file" aria-label="Delete file">
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      {editing && <EditFileModal file={file} onClose={() => setEditing(false)} onSaved={onChanged} />}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={() => setConfirming(false)}>
          <div
            className="w-full max-w-sm overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between border-b border-rule px-4 py-3">
              <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Delete File</h3>
              <button onClick={() => setConfirming(false)} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-4">
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-ink-dim" />
                <span className="truncate font-mono text-xs text-ink" title={file.relativePath}>{file.relativePath}</span>
              </div>
              <p className="text-sm text-ink-dim">Delete this file from disk? This cannot be undone.</p>
              {removeFile.isError && <p className="mt-2 text-xs text-err">{removeFile.error instanceof Error ? removeFile.error.message : "Failed to delete"}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
              <button onClick={() => setConfirming(false)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
              <button
                onClick={() => removeFile.mutate()}
                disabled={removeFile.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-err px-3 py-1.5 text-sm font-semibold text-white hover:bg-err/90 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> {removeFile.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
