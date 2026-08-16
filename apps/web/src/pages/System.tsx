// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Play, Webhook, Database, Copy, Check, RotateCw, Eye, EyeOff, Lock, HeartPulse } from "lucide-react";
import { api } from "../api/client";
import type { JobRun, JobDefinition, HealthStatus } from "../api/types";
import { Badge, statusTone, ErrorState, formatDate } from "../lib/ui";

function healthTone(level: string): "ok" | "warn" | "danger" {
  return level === "ok" ? "ok" : level === "warning" ? "warn" : "danger";
}

const inputCls = "rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const wideInputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";
const monoInputCls = "flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export default function System() {
  const qc = useQueryClient();
  const [themeSetting, setThemeSetting] = useState("");
  const regenerateKey = useMutation({
    mutationFn: () => api.post<{ rawKey: string }>("/auth/regenerate-key"),
    onSuccess: () => setRevealedKey(undefined),
  });
  const [revealedKey, setRevealedKey] = useState<string | null | undefined>(undefined); // undefined = not fetched, null = fetched but unavailable (pre-dates reveal support)
  const [revealCopied, setRevealCopied] = useState(false);
  const revealKey = useMutation({
    mutationFn: () => api.get<{ rawKey: string | null }>("/auth/key"),
    onSuccess: (res) => setRevealedKey(res.rawKey),
  });
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [passwordError, setPasswordError] = useState("");
  const changePassword = useMutation({
    mutationFn: () => api.put("/auth/password", { currentPassword: passwordForm.current, newPassword: passwordForm.next }),
    onSuccess: () => { setPasswordForm({ current: "", next: "", confirm: "" }); setPasswordError(""); },
    onError: (err) => setPasswordError(err instanceof Error ? err.message : "Failed to change password"),
  });
  const [notifyDraft, setNotifyDraft] = useState({ url: "", secret: "", eventTypes: "" });
  const [savedNotification, setSavedNotification] = useState(false);
  const saveWebhooks = useMutation({
    mutationFn: (body: { url: string; secret?: string; eventTypes: string[] }) => api.post("/notifications", { kind: "webhook", settings: { url: body.url, secret: body.secret }, eventTypes: body.eventTypes }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); qc.invalidateQueries({ queryKey: ["notifications"] }); setSavedNotification(true); },
  });
  const notifications = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<any[]>("/notifications") });
  const [tmdbKeyDraft, setTmdbKeyDraft] = useState("");
  const [savedTmdb, setSavedTmdb] = useState(false);
  const saveTmdb = useMutation({
    mutationFn: (tmdbApiKey: string) => api.put("/system/config", { "metadata.tmdbApiKey": tmdbApiKey }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); setSavedTmdb(true); },
  });

  const runs = useQuery({ queryKey: ["job-runs"], queryFn: () => api.get<JobRun[]>("/system/jobs/runs") });
  const jobDefs = useQuery({ queryKey: ["job-defs"], queryFn: () => api.get<JobDefinition[]>("/system/jobs") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<any[]>("/system/audit") });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<HealthStatus>("/system/health") });

  const trigger = useMutation({
    mutationFn: (jobKey: string) => api.post(`/system/commands/${jobKey}`),
    onSuccess: () => setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["job-runs"] });
      qc.invalidateQueries({ queryKey: ["job-defs"] });
      qc.invalidateQueries({ queryKey: ["health"] });
    }, 800),
  });

  const cancelRun = useMutation({
    mutationFn: (id: string) => api.del(`/system/commands/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-runs"] }),
  });
  const CANCELLABLE_STATUSES = new Set(["queued", "running", "retrying"]);

  const saveTheme = useMutation({
    mutationFn: (theme: string) => api.put("/system/config", { "ui.theme": theme }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const [parseTitle, setParseTitle] = useState("");
  const parse = useMutation({
    mutationFn: (title: string) => api.get<any>(`/system/parse?title=${encodeURIComponent(title)}`),
  });

  const endpoints = [
    ["GET", "/api/v1/system/status"], ["GET", "/api/v1/system/config"], ["PUT", "/api/v1/system/config"],
    ["POST", "/api/v1/system/commands/:jobKey"], ["GET", "/api/v1/system/commands/:id"], ["DELETE", "/api/v1/system/commands/:id"],
    ["GET", "/api/v1/system/jobs"], ["GET", "/api/v1/system/jobs/runs"],
    ["GET", "/api/v1/system/health"], ["GET", "/api/v1/system/backups"],
    ["GET", "/api/v1/movies"], ["POST", "/api/v1/movies"], ["GET", "/api/v1/series"], ["POST", "/api/v1/series"],
    ["GET", "/api/v1/series/:id/seasons"], ["POST", "/api/v1/search"], ["POST", "/api/v1/grabs"],
    ["GET", "/api/v1/indexers"], ["POST", "/api/v1/indexers"], ["GET", "/api/v1/indexers/definitions"],
    ["GET", "/api/v1/history"], ["GET", "/api/v1/queue"], ["GET", "/api/v1/auth/whoami"],
    ["GET", "/api/v1/auth/key"], ["POST", "/api/v1/auth/regenerate-key"], ["GET", "/api/v1/auth/status"],
    ["POST", "/api/v1/auth/login"], ["POST", "/api/v1/auth/logout"], ["PUT", "/api/v1/auth/password"],
    ["GET", "/health/live"], ["GET", "/health/ready"], ["GET", "/api/sonarr/v3/system/status"],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">System</h2>
        <p className="text-sm text-ink-dim">Jobs, configuration, and API surface.</p>
      </div>

      {runs.isError && <ErrorState error={runs.error} onRetry={() => runs.refetch()} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-rule bg-surface p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Job runs</h3>
            <button onClick={() => trigger.mutate("system.healthCheck")} disabled={trigger.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
              <Play className="h-3.5 w-3.5" /> Run health check
            </button>
          </div>
          {jobDefs.data && jobDefs.data.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {jobDefs.data.map((d) => {
                const overdue = d.nextRunAt ? new Date(d.nextRunAt).getTime() <= Date.now() : false;
                return (
                  <span key={d.key} className="flex items-center gap-1.5 rounded-full border border-rule bg-bg px-2.5 py-1 text-xs" title={d.schedule}>
                    <span className="font-mono text-ink-dim">{d.key}</span>
                    {d.nextRunAt ? <Badge tone={overdue ? "warn" : "neutral"}>{overdue ? "overdue" : formatDate(d.nextRunAt)}</Badge> : <Badge tone="neutral">disabled</Badge>}
                  </span>
                );
              })}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="pb-2">Job</th><th className="pb-2">Status</th><th className="pb-2">Trigger</th><th className="pb-2">Attempt</th><th className="pb-2">Finished</th><th className="pb-2"></th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {runs.data?.slice(0, 15).map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 font-mono text-xs">{r.jobKey}</td>
                    <td className="py-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                    <td className="py-2 text-ink-dim">{r.trigger}</td>
                    <td className="py-2 text-ink-dim">{r.attempt}</td>
                    <td className="py-2 text-ink-dim">{formatDate(r.finishedAt)}</td>
                    <td className="py-2 text-right">
                      {CANCELLABLE_STATUSES.has(r.status) && (
                        <button onClick={() => cancelRun.mutate(r.id)} disabled={cancelRun.isPending}
                          className="rounded-md px-2 py-1 text-xs font-medium text-err hover:bg-err-bg disabled:opacity-50">
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-rule bg-surface p-4">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Configuration</h3>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">UI theme</span>
            <div className="flex gap-1 rounded-lg border border-rule bg-bg p-1">
              {(["dark", "light"] as const).map((t) => (
                <button key={t} onClick={() => { setThemeSetting(t); saveTheme.mutate(t); }}
                  className={`flex-1 rounded-md px-3 py-1 text-sm font-display font-semibold uppercase tracking-wide capitalize transition-colors ${themeSetting === t || ((cfg.data as any)?.["ui.theme"]) === t ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-surface hover:text-ink"}`}>
                  {t}
                </button>
              ))}
            </div>
          </label>
          <p className="text-xs text-ink-dim">Settings persist via the <code className="rounded bg-neutral-bg px-1 text-ink">setting</code> table. Endpoint inventory below reflects the native + compat API.</p>
        </section>
      </div>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><HeartPulse className="h-4 w-4" /> Health</h3>
          {health.data?.checkedAt && <span className="text-xs text-ink-dim">Last checked {formatDate(health.data.checkedAt)}</span>}
        </div>
        {health.isError && <ErrorState error={health.error} onRetry={() => health.refetch()} />}
        {!health.isError && !health.data?.results.length && (
          <p className="text-sm text-ink-dim">No results yet — run a health check above.</p>
        )}
        {!!health.data?.results.length && (
          <div className="grid gap-2 sm:grid-cols-2">
            {health.data.results.map((r) => (
              <div key={r.key} className="flex items-start gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
                <Badge tone={healthTone(r.level)}>{r.level}</Badge>
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-ink-dim">{r.key}</p>
                  <p className="text-xs text-ink">{r.message}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Database className="h-4 w-4" /> Metadata (TMDB)</h3>
        <p className="mb-3 text-xs text-ink-dim">
          Powers Discover and per-title metadata refresh. Get a free API key at{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="underline text-accent">themoviedb.org/settings/api</a>.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setSavedTmdb(false); saveTmdb.mutate(tmdbKeyDraft); }}
        >
          <input
            value={tmdbKeyDraft}
            onChange={(e) => setTmdbKeyDraft(e.target.value)}
            placeholder={cfg.data?.["metadata.tmdbApiKey"] ? "•••••••••••••••• (set — paste to replace)" : "TMDB API key"}
            className={monoInputCls}
          />
          <button disabled={saveTmdb.isPending || !tmdbKeyDraft} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {saveTmdb.isPending ? "Saving…" : "Save"}
          </button>
        </form>
        {savedTmdb && <p className="mt-2 text-xs text-ok">Saved.</p>}
        <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-dim">
          Series episode numbering (absolute &amp; scene) is provided by{" "}
          <a href="https://www.thetvdb.com/" target="_blank" rel="noreferrer" className="underline text-accent">TheTVDB</a>.
        </p>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Webhook className="h-4 w-4" /> Notifications</h3>
        <p className="mb-3 text-xs text-ink-dim">Webhook (JSON), Discord webhook, Telegram Bot, Email — alerts for grabs, imports, and indexer/download-client failures. Configure sinks with per-event subscriptions.</p>
        <div className="space-y-3">
          <form
            className="rounded-lg border border-rule bg-bg p-3"
            onSubmit={(e) => { e.preventDefault(); const eventTypes = notifyDraft.eventTypes ? notifyDraft.eventTypes.split(",").map((s) => s.trim()) : []; saveWebhooks.mutate({ url: notifyDraft.url, secret: notifyDraft.secret || undefined, eventTypes }); setNotifyDraft({ url: "", secret: "", eventTypes: "" }); }}
          >
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-dim">Add webhook</p>
            <div className="flex gap-2">
              <input required placeholder="https://hook.example/medianexus" value={notifyDraft.url} onChange={(e) => setNotifyDraft({ ...notifyDraft, url: e.target.value })} className={wideInputCls} />
              <button className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">Add</button>
            </div>
          </form>
          <div className="grid gap-2 text-xs font-mono text-ink-dim">
            <span>webhooks: {(notifications.data ?? []).filter((n: any) => n.kind === "webhook").length}</span>
            <span>discord: {(notifications.data ?? []).filter((n: any) => n.kind === "discord").length}</span>
            <span>telegram: {(notifications.data ?? []).filter((n: any) => n.kind === "telegram").length}</span>
            <span>email: {(notifications.data ?? []).filter((n: any) => n.kind === "email").length}</span>
          </div>
          {savedNotification && <p className="text-xs text-ok">Saved.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Audit trail</h3>
        {audit.isLoading ? <p className="text-sm text-ink-dim">Loading…</p> : audit.data?.length === 0 ? <p className="text-sm text-ink-dim">No audit entries.</p> : (
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {audit.data?.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg px-3 py-1.5">
                <span className="truncate font-mono">{e.action}</span>
                <span className="text-ink-dim">{new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-ink-dim" />
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">API key (for external tools)</h3>
        </div>
        <p className="mb-2 text-xs text-ink-dim">
          Your browser session doesn't need this — it's for configuring Sonarr/Radarr/Prowlarr-compatible clients or
          scripts against this instance's <code className="rounded bg-neutral-bg px-1 text-ink">/api/v1</code>{" "}
          (or compat) surface via the <code className="rounded bg-neutral-bg px-1 text-ink">X-Api-Key</code> header.
        </p>
        <button
          onClick={() => {
            if (!window.confirm("Regenerate the API key? The current key stops working immediately — anything using the old one (scripts, other tools) will need the new one.")) return;
            regenerateKey.mutate();
          }}
          disabled={regenerateKey.isPending}
          className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink disabled:opacity-50"
        >
          <RotateCw className={`h-3 w-3 ${regenerateKey.isPending ? "animate-spin" : ""}`} /> Regenerate key
        </button>
        {regenerateKey.isSuccess && <p className="mt-1 text-xs text-ok">New key generated.</p>}
        {regenerateKey.isError && <p className="mt-1 text-xs text-err">{regenerateKey.error instanceof Error ? regenerateKey.error.message : "Failed to regenerate"}</p>}

        <div className="mt-4 border-t border-rule pt-3">
          {revealedKey === undefined ? (
            <button
              onClick={() => revealKey.mutate()}
              disabled={revealKey.isPending}
              className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-ink disabled:opacity-50"
            >
              <Eye className="h-3 w-3" /> Reveal current key
            </button>
          ) : revealedKey === null ? (
            <p className="text-xs text-warn">
              This key predates reveal support — regenerate it once above to enable revealing it later.
            </p>
          ) : (
            <div className="flex gap-2">
              <input
                readOnly
                value={revealedKey}
                className="flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink"
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(revealedKey).then(() => { setRevealCopied(true); setTimeout(() => setRevealCopied(false), 1500); });
                }}
                title="Copy to clipboard"
                className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule"
              >
                {revealCopied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => setRevealedKey(undefined)}
                title="Hide"
                className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule"
              >
                <EyeOff className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink"><Lock className="h-4 w-4" /> Change password</h3>
        <p className="mb-3 text-xs text-ink-dim">Changing your password signs out every other browser session — including anywhere else you're currently logged in.</p>
        <form
          className="grid gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (passwordForm.next.length < 8) { setPasswordError("New password must be at least 8 characters."); return; }
            if (passwordForm.next !== passwordForm.confirm) { setPasswordError("New passwords don't match."); return; }
            changePassword.mutate();
          }}
        >
          <input
            type="password"
            required
            placeholder="Current password"
            value={passwordForm.current}
            onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })}
            className={inputCls}
          />
          <input
            type="password"
            required
            placeholder="New password"
            value={passwordForm.next}
            onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })}
            className={inputCls}
          />
          <div className="flex gap-2">
            <input
              type="password"
              required
              placeholder="Confirm new password"
              value={passwordForm.confirm}
              onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
              className="flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <button disabled={changePassword.isPending} className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
              {changePassword.isPending ? "Saving…" : "Update"}
            </button>
          </div>
        </form>
        {passwordError && <p className="mt-2 text-xs text-err">{passwordError}</p>}
        {changePassword.isSuccess && <p className="mt-2 text-xs text-ok">Password updated.</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Parse a release title</h3>
        <p className="mb-3 text-xs text-ink-dim">Debug: run a raw release title through the release-title + episode parsers to see exactly what was extracted and why it might not match your library. Read-only.</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (parseTitle.trim()) parse.mutate(parseTitle.trim()); }}
        >
          <input
            value={parseTitle}
            onChange={(e) => setParseTitle(e.target.value)}
            placeholder="Show.Name.S01E02.1080p.WEB-DL.x264-GROUP"
            className={monoInputCls}
          />
          <button disabled={parse.isPending || !parseTitle.trim()} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">
            {parse.isPending ? "Parsing…" : "Parse"}
          </button>
        </form>
        {parse.isError && <p className="mt-2 text-xs text-err">{parse.error instanceof Error ? parse.error.message : "Failed to parse"}</p>}
        {parse.data && (
          <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-rule bg-bg p-3 text-xs leading-relaxed text-ink">
            {JSON.stringify(parse.data, null, 2)}
          </pre>
        )}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">API surface</h3>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {endpoints.map(([m, p]) => (
            <div key={`${m}-${p}`} className="flex items-center gap-2 rounded-lg border border-rule bg-bg px-3 py-1.5 font-mono text-xs">
              <span className={`font-semibold ${m === "GET" ? "text-ok" : m === "POST" ? "text-accent" : m === "PUT" ? "text-warn" : "text-err"}`}>{m}</span>
              <span className="truncate text-ink-dim">{p}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
