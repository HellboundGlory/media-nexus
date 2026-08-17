// SPDX-License-Identifier: MIT
// BulkDeleteModal — UNI-020 "Delete" bulk toolbar action. Lighter than the single-item
// DeleteConfirmModal (no per-file size/folder preview): just a name list, the same two opt-in
// checkboxes (default unchecked), and a plain warn-tone confirmation line.
import { useState } from "react";
import { Modal } from "./Modal";

export interface BulkDeleteOptions {
  deleteFiles: boolean;
  addImportExclusion: boolean;
}

export function BulkDeleteModal({
  mediaType,
  names,
  busy,
  onConfirm,
  onClose,
}: {
  mediaType: "movie" | "series";
  names: string[];
  busy?: boolean;
  onConfirm: (opts: BulkDeleteOptions) => void;
  onClose: () => void;
}) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [addImportExclusion, setAddImportExclusion] = useState(false);
  const plural = mediaType === "movie" ? "movies" : "shows";
  const singular = mediaType === "movie" ? "movie" : "show";

  return (
    <Modal
      title={`Delete ${names.length} ${plural}?`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Cancel</button>
          <button
            onClick={() => onConfirm({ deleteFiles, addImportExclusion })}
            disabled={busy}
            className="rounded-lg bg-err px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-err/90 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <p className="rounded-lg border border-err/40 bg-err-bg px-3 py-2 text-xs text-err-ink">
          This will remove {names.length} {plural} from your library
          {deleteFiles ? " and permanently delete their files from disk" : ""}.
        </p>
        <ul className="max-h-40 divide-y divide-rule overflow-y-auto rounded-lg border border-rule">
          {names.map((n) => <li key={n} className="px-3 py-1.5 text-sm text-ink">{n}</li>)}
        </ul>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={addImportExclusion} onChange={(e) => setAddImportExclusion(e.target.checked)} />
          <span>
            <span className="block text-sm font-semibold text-ink">Add List Exclusion</span>
            <span className="block text-xs text-ink-dim">Prevent these {singular}s from being re-added the next time an import list syncs.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
          <span>
            <span className="block text-sm font-semibold text-ink">{mediaType === "movie" ? "Delete Movie Files" : "Delete Series Files"}</span>
            <span className="block text-xs text-ink-dim">Permanently delete the files and folder from disk. This cannot be undone.</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
