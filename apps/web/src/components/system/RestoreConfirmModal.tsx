// SPDX-License-Identifier: MIT
// RestoreConfirmModal (BACKUPRESTORE-1) — the deliberate destructive-confirm for restoring a
// backup over the entire live database. Mirrors DeleteConfirmModal's structure on purpose: a
// warn-tone block spelling out exactly what is lost + how it is protected, and a red confirm
// button. The app restarts after the swap, so the post-confirm UI (not this modal) takes over.
import { RotateCcw, ShieldCheck, X } from "lucide-react";

export function RestoreConfirmModal({
  name,
  busy,
  onConfirm,
  onClose,
}: {
  name: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">Restore Backup?</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
            <RotateCcw className="h-4 w-4 shrink-0 text-ink-dim" />
            <span className="truncate font-mono text-xs text-ink" title={name}>{name}</span>
          </div>

          <div className="rounded-lg border border-err/40 bg-err-bg px-3 py-2 text-sm text-err-ink">
            This will replace the <span className="font-semibold">entire</span> current database —
            your library, settings, media server and download-client credentials, and history —
            with the state from this backup. This cannot be undone.
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-rule bg-bg px-3 py-2 text-xs text-ink-dim">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            <span>
              A safety copy of your current database is made automatically first (kept in the backup list), and the app
              will <span className="font-semibold text-ink">restart and be briefly unavailable</span> during the restore.
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-rule px-4 py-3">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-err px-3 py-1.5 text-sm font-semibold text-white hover:bg-err/90 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {busy ? "Restoring…" : "Restore & Restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
