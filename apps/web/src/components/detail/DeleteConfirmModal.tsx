// SPDX-License-Identifier: MIT
// DeleteConfirmModal — the deliberate delete-by-hand confirm for a movie/series (FILEMGMT-1).
// Replaces the detail pages' window.confirm with a real modal that makes the two opt-in flags
// explicit: "Add List Exclusion" and "Delete Files" (both default unchecked). When "Delete
// Files" is checked a warn-tone block shows how many files/size and which folder will be removed
// from disk. Reuses the InteractiveSearchModal shell and the AutoTags native-checkbox pattern.
import { useState } from "react";
import { Folder, Trash2, X } from "lucide-react";
import { formatBytes } from "../../lib/ui";

export interface DeleteOptions {
  deleteFiles: boolean;
  addImportExclusion: boolean;
}

export function DeleteConfirmModal({
  title,
  mediaType,
  folderPath,
  folderName,
  fileCount,
  totalBytes,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  mediaType: "movie" | "series";
  folderPath: string;
  folderName: string;
  fileCount: number;
  totalBytes: number;
  busy?: boolean;
  onConfirm: (opts: DeleteOptions) => void;
  onClose: () => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [addImportExclusion, setAddImportExclusion] = useState(false);
  const singular = mediaType === "movie" ? "movie" : "show";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Delete {"\u201C"}{title}{"\u201D"}?</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
            <Folder className="h-4 w-4 shrink-0 text-ink-dim" />
            <span className="truncate font-mono text-xs text-ink" title={folderPath}>{folderPath || "\u2014"}</span>
          </div>

          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={addImportExclusion} onChange={(e) => setAddImportExclusion(e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold text-ink">Add List Exclusion</span>
              <span className="block text-xs text-ink-dim">Prevent this {singular} from being re-added the next time an import list syncs.</span>
            </span>
          </label>

          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold text-ink">{mediaType === "movie" ? "Delete Movie Files" : "Delete Series Files"}</span>
              <span className="block text-xs text-ink-dim">Permanently delete the files and folder from disk. This cannot be undone.</span>
            </span>
          </label>

          {deleteFiles && (
            <div className="rounded-lg border border-err/40 bg-err-bg px-3 py-2 text-sm text-err-ink">
              This will delete <span className="font-semibold">{fileCount} file(s)</span> (<span className="font-semibold tabular-nums">{formatBytes(totalBytes)}</span>)
              {" "}and remove the folder <span className="font-mono">{folderName}</span> from disk.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
          <button
            onClick={() => onConfirm({ deleteFiles, addImportExclusion })}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-err px-3 py-1.5 text-sm font-semibold text-white hover:bg-err/90 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
