// SPDX-License-Identifier: MIT
// Settings > General (NAV-1 Phase 4): API key (regenerate/reveal) + Change password — both
// relocated verbatim from System's old page. Plus a Backups section (UNI-024) editing the two
// real /system/config keys consumed by BackupService (backupPath + backupRetentionCount).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RotateCw, Eye, EyeOff, Copy, Check, Lock, Archive } from "lucide-react";
import { api } from "../../api/client";

const inputCls = "rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const labelCls = "mb-1 block text-xs text-ink-dim";

// Backup settings draft (UNI-024) — the two real /system/config keys consumed by BackupService:
// `system.backupPath` (string) and `system.backupRetentionCount` (number-as-string input, same
// convention as MediaManagementTab's recycleBinRetentionDays).
interface BackupDraft {
  backupPath: string;
  backupRetentionCount: string;
}
const emptyBackupDraft: BackupDraft = { backupPath: "", backupRetentionCount: "" };
function backupDraftFromCfg(c: Record<string, unknown> | undefined): BackupDraft {
  if (!c) return emptyBackupDraft;
  return {
    backupPath: String(c["system.backupPath"] ?? ""),
    backupRetentionCount: c["system.backupRetentionCount"] != null ? String(c["system.backupRetentionCount"]) : "",
  };
}

export function GeneralTab() {
  // Backup settings (UNI-024) — a separate /system/config draft from the API-key/password
  // sections below; saving it PUTs ONLY the two backup keys, not the whole config.
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const [bd, setBd] = useState<BackupDraft>(emptyBackupDraft);
  useEffect(() => { if (cfg.data) setBd(backupDraftFromCfg(cfg.data)); }, [cfg.data]);
  const saveBackups = useMutation({
    mutationFn: () => api.put("/system/config", {
      "system.backupPath": bd.backupPath,
      "system.backupRetentionCount": Number(bd.backupRetentionCount || 0),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const regenerateKey = useMutation({ mutationFn: () => api.post<{ rawKey: string }>("/auth/regenerate-key"), onSuccess: () => setRevealedKey(undefined) });
  const [revealedKey, setRevealedKey] = useState<string | null | undefined>(undefined);
  const [revealCopied, setRevealCopied] = useState(false);
  const revealKey = useMutation({ mutationFn: () => api.get<{ rawKey: string | null }>("/auth/key"), onSuccess: (res) => setRevealedKey(res.rawKey) });
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [passwordError, setPasswordError] = useState("");
  const changePassword = useMutation({
    mutationFn: () => api.put("/auth/password", { currentPassword: passwordForm.current, newPassword: passwordForm.next }),
    onSuccess: () => { setPasswordForm({ current: "", next: "", confirm: "" }); setPasswordError(""); },
    onError: (err) => setPasswordError(err instanceof Error ? err.message : "Failed to change password"),
  });

  const submitPassword = () => {
    if (passwordForm.next.length < 8) { setPasswordError("New password must be at least 8 characters."); return; }
    if (passwordForm.next !== passwordForm.confirm) { setPasswordError("New passwords don't match."); return; }
    changePassword.mutate();
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-ink-dim" />
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">API key (for external tools)</h3>
        </div>
        <p className="mb-2 text-xs text-ink-dim">
          Your browser session doesn't need this — it's for configuring compatible clients or scripts against
          this instance's <code className="rounded bg-neutral-bg px-1 text-ink">/api/v1</code> (or compat) surface
          via the <code className="rounded bg-neutral-bg px-1 text-ink">X-Api-Key</code> header.
        </p>
        <button
          onClick={() => { if (!window.confirm("Regenerate the API key? The current key stops working immediately.")) return; regenerateKey.mutate(); }}
          disabled={regenerateKey.isPending}
          className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink disabled:opacity-50"
        >
          <RotateCw className={`h-3 w-3 ${regenerateKey.isPending ? "animate-spin" : ""}`} /> Regenerate key
        </button>
        {regenerateKey.isSuccess && <p className="mt-1 text-xs text-ok">New key generated.</p>}
        {regenerateKey.isError && <p className="mt-1 text-xs text-err">{regenerateKey.error instanceof Error ? regenerateKey.error.message : "Failed to regenerate"}</p>}

        <div className="mt-4 border-t border-rule pt-3">
          {revealedKey === undefined ? (
            <button onClick={() => revealKey.mutate()} disabled={revealKey.isPending} className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink disabled:opacity-50">
              <Eye className="h-3 w-3" /> Reveal current key
            </button>
          ) : revealedKey === null ? (
            <p className="text-xs text-warn">This key predates reveal support — regenerate it once above.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input readOnly value={revealedKey} className="flex-1 min-w-64 rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink" />
              <button onClick={() => { navigator.clipboard.writeText(revealedKey).then(() => { setRevealCopied(true); setTimeout(() => setRevealCopied(false), 1500); }); }} title="Copy to clipboard" className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule">
                {revealCopied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => setRevealedKey(undefined)} title="Hide" className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule"><EyeOff className="h-3.5 w-3.5" /></button>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><Lock className="h-4 w-4" /> Change password</h3>
        <p className="mb-3 text-xs text-ink-dim">Changing your password signs out every other browser session — including anywhere else you're currently logged in.</p>
        <form className="grid gap-2 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); submitPassword(); }}>
          <input type="password" required placeholder="Current password" value={passwordForm.current} onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })} className={inputCls} />
          <input type="password" required placeholder="New password" value={passwordForm.next} onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })} className={inputCls} />
          <div className="flex gap-2">
            <input type="password" required placeholder="Confirm new password" value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} className="flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40" />
            <button disabled={changePassword.isPending} className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{changePassword.isPending ? "Saving…" : "Update"}</button>
          </div>
        </form>
        {passwordError && <p className="mt-2 text-xs text-err">{passwordError}</p>}
        {changePassword.isSuccess && <p className="mt-2 text-xs text-ok">Password updated.</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Archive className="h-4 w-4 text-ink-dim" />
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Backups</h3>
        </div>
        <p className="mb-3 text-xs text-ink-dim">
          Backups run on a fixed weekly schedule (Sunday 3am) and can be triggered manually from System → Tasks.
          Browse, download, upload and restore them from System → Backup.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Backup folder</span>
            <input value={bd.backupPath} onChange={(e) => setBd((p) => ({ ...p, backupPath: e.target.value }))} placeholder="/data/backups" className={monoCls} />
            <p className="mt-1 text-xs text-ink-dim">Leave empty to disable backups.</p>
          </label>
          <label className="block">
            <span className={labelCls}>Retention (backups to keep)</span>
            <input type="number" value={bd.backupRetentionCount} onChange={(e) => setBd((p) => ({ ...p, backupRetentionCount: e.target.value }))} className={inputCls} />
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-dim">
          The N most recent scheduled/manual backups are kept; older ones are trimmed automatically.
          Safety copies (made before a restore) and manually uploaded backups are never counted or trimmed.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button onClick={() => saveBackups.mutate()} disabled={saveBackups.isPending} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{saveBackups.isPending ? "Saving…" : "Save"}</button>
          {saveBackups.isSuccess && <span className="text-xs text-ok">Saved.</span>}
        </div>
        {saveBackups.isError && <p className="mt-2 text-xs text-err">{saveBackups.error instanceof Error ? saveBackups.error.message : "Failed to save"}</p>}
      </section>
    </div>
  );
}
