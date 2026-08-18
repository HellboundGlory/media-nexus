// SPDX-License-Identifier: MIT
// System > Backup (NAV-1 Phase 4 + BACKUPRESTORE-1): list backups (GET /system/backups),
// Backup Now trigger (POST /system/commands/system.backup), Download (GET /.../download),
// Restore (POST /.../restore + restart), and Upload (POST /.../upload). The old "Restore is
// not available" line is gone — restore/download/upload are the in-app half of the story.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, Loader2, Play, RotateCcw, Upload } from "lucide-react";
import { api, ApiClientError, API_BASE } from "../../api/client";
import type { JobRun } from "../../api/types";
import { EmptyState, ErrorState, formatDate, formatBytes } from "../../lib/ui";
import { RestoreConfirmModal } from "../../components/system/RestoreConfirmModal";

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

// Poll /health/ready until the app is back, then reload. The server exits during restore
// (even mid-response), so the restore POST may resolve OR reject with a network error — both
// mean the swap happened and the app is restarting, and we treat them the same.
const READY_POLL_MS = 2000;
const READY_POLL_CAP_S = 60;

// "Backup Now" (POST /system/commands/system.backup) only enqueues a job run and returns its
// queued JobRunRecord — the actual backup runs asynchronously in the job engine, which
// persists the outcome (including any failure's error string) back onto that run row. We
// poll GET /system/commands/:id until the run is terminal so a real failure (e.g. a
// misconfigured backup path causing ENOENT) is surfaced inline instead of the old blind
// setTimeout that made failures invisible (BACKUPFAIL-1).
const BACKUP_POLL_MS = 1000;
const BACKUP_POLL_CAP_S = 60;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

type BackupRunState =
  | { status: "idle" }
  | { status: "running"; runId: string }
  | { status: "succeeded"; runId: string; message: string }
  | { status: "failed"; runId?: string; message: string }
  | { status: "cancelled"; runId?: string; message: string };

function RestartingOverlay() {
  const [timedOut, setTimedOut] = useState(false);
  const [dismiss, setDismiss] = useState(false);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (dismiss) return;
      try {
        const res = await fetch("/health/ready");
        if (res.ok) {
          clearInterval(timer);
          window.location.reload();
          return;
        }
      } catch {
        /* app still down — keep polling */
      }
      if (Date.now() - startedAt > READY_POLL_CAP_S * 1000) {
        clearInterval(timer);
        setTimedOut(true);
      }
    }, READY_POLL_MS);
    return () => clearInterval(timer);
  }, [dismiss]);

  if (timedOut && !dismiss) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
        <div className="w-full max-w-sm rounded-xl border border-rule bg-surface p-6 text-center shadow-2xl">
          <p className="text-sm font-semibold text-ink">Still waiting for MediaNexus to come back&hellip;</p>
          <p className="mt-1 text-xs text-ink-dim">The restore was applied, but the app hasn't returned within {READY_POLL_CAP_S}s. It may still be restarting — refresh the page shortly.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button onClick={() => window.location.reload()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink">Refresh now</button>
            <button onClick={() => setDismiss(true)} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs text-ink">Dismiss</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
        <p className="text-sm font-semibold text-ink">Restarting&hellip;</p>
        <p className="max-w-sm text-xs text-ink-dim">The database has been replaced with the selected backup and MediaNexus is restarting. This page will reload automatically once it&rsquo;s back.</p>
      </div>
    </div>
  );
}

export function BackupTab() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backups = useQuery({ queryKey: ["backups"], queryFn: () => api.get<BackupFile[]>("/system/backups") });
  const [backupRun, setBackupRun] = useState<BackupRunState>({ status: "idle" });
  const trigger = useMutation({
    mutationFn: () => api.post<JobRun>("/system/commands/system.backup"),
    onMutate: () => setBackupRun({ status: "idle" }),
    onSuccess: (run) => setBackupRun({ status: "running", runId: run.id }),
    onError: (err) =>
      setBackupRun({
        status: "failed",
        message: err instanceof Error ? err.message : "Backup could not be started",
      }),
  });

  // Poll the dispatched run until it reaches a terminal state, then surface success or the
  // engine-persisted error inline (mirroring the Indexers/Clients test-button pattern). A
  // real backup failure is captured on the run row by the job engine, so polling the run is
  // how the UI learns about it.
  const runId = backupRun.status === "running" ? backupRun.runId : null;
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();
    const poll = async () => {
      try {
        const run = await api.get<JobRun>(`/system/commands/${runId}`);
        if (cancelled) return;
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          qc.invalidateQueries({ queryKey: ["backups"] });
          if (run.status === "succeeded") {
            setBackupRun({ status: "succeeded", runId: run.id, message: "Backup created." });
          } else if (run.status === "failed" || run.status === "timed_out") {
            setBackupRun({ status: "failed", runId: run.id, message: run.error || `Backup ${run.status}` });
          } else {
            setBackupRun({ status: "cancelled", runId: run.id, message: "Backup was cancelled." });
          }
          return;
        }
        if (Date.now() - startedAt > BACKUP_POLL_CAP_S * 1000) {
          setBackupRun({
            status: "failed",
            runId: run.id,
            message: `Backup is still running after ${BACKUP_POLL_CAP_S}s — check System > Tasks for the job result.`,
          });
          return;
        }
        timer = setTimeout(poll, BACKUP_POLL_MS);
      } catch (e) {
        if (cancelled) return;
        setBackupRun({
          status: "failed",
          runId,
          message: e instanceof Error ? e.message : "Failed to check backup status",
        });
      }
    };
    timer = setTimeout(poll, BACKUP_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, qc]);

  // Restore: arm the restarting state immediately on confirm. A server-side rejection (an
  // ApiClientError — the server was alive and refused) means the restore did NOT run, so we
  // surface it and return to the list. Any other failure (network error from the server
  // exiting mid-response) is the successful-restart case and stays on the overlay.
  const restore = useMutation({
    mutationFn: (name: string) => api.post(`/system/backups/${encodeURIComponent(name)}/restore`),
    onMutate: () => setRestarting(true),
    onError: (err) => {
      if (err instanceof ApiClientError) {
        setRestarting(false);
        setError(err.message);
        setConfirmName(null);
      }
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch(`${API_BASE}/system/backups/upload`, { method: "POST", body: fd }).then(async (res) => {
        if (!res.ok) {
          let msg = `Upload failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            msg = body?.error?.message ?? msg;
          } catch {
            /* non-JSON error body */
          }
          throw new Error(msg);
        }
        return (await res.json()) as BackupFile;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups"] });
      setError(null);
    },
  });

  const onUploadFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    upload.mutate(file);
  };

  const rows = backups.data ?? [];
  const errorMsg = (e: unknown): string | null => (e instanceof Error ? e.message : e ? String(e) : null);
  const mutationError = error ?? (backupRun.status === "failed" ? backupRun.message : null) ?? (upload.isError ? errorMsg(upload.error) : null);
  const backupSucceeded = backupRun.status === "succeeded" ? backupRun.message : null;
  const backingUp = trigger.isPending || backupRun.status === "running";

  if (restarting) return <RestartingOverlay />;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><DatabaseBackup className="h-4 w-4" /> Backups</h3>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".sqlite3,.db,.sqlite"
              className="hidden"
              onChange={(e) => { onUploadFile(e.target.files?.[0]); e.target.value = ""; }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-bg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" /> {upload.isPending ? "Uploading…" : "Upload Backup"}
            </button>
            <button
              onClick={() => trigger.mutate()}
              disabled={backingUp}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> {backingUp ? "Backing up…" : "Backup Now"}
            </button>
          </div>
        </div>
        {backupSucceeded && <p className="mb-2 text-xs text-ok">{backupSucceeded}</p>}
        {mutationError && <p className="mb-2 text-xs text-err">{mutationError}</p>}
        {backups.isError ? <ErrorState error={backups.error} onRetry={() => backups.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No backups yet" hint="Run Backup Now (or let the scheduled system.backup job run) to create one. You can also upload a backup from another host. Backing up requires a configured backup path in Media Management." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Created</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((b) => (
                  <tr key={b.name}>
                    <td className="px-3 py-2 font-mono text-xs text-ink">{b.name}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-2 text-ink-dim">{formatDate(b.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <a
                          href={`${API_BASE}/system/backups/${encodeURIComponent(b.name)}/download`}
                          download
                          title="Download backup"
                          className="rounded-md p-1.5 text-ink-dim hover:bg-bg hover:text-ink"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                        <button
                          onClick={() => { setError(null); setConfirmName(b.name); }}
                          title="Restore this backup"
                          className="rounded-md p-1.5 text-ink-dim hover:bg-err-bg hover:text-err"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-dim">Backups contain the full database (settings included). Restoring replaces the entire current database and restarts the app; a safety copy of the current database is kept automatically.</p>
      </section>

      {confirmName && (
        <RestoreConfirmModal
          name={confirmName}
          busy={restore.isPending}
          onConfirm={() => restore.mutate(confirmName)}
          onClose={() => setConfirmName(null)}
        />
      )}
    </div>
  );
}
