// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Play, Webhook, Database, Copy, Check, RotateCw, Eye, EyeOff, Lock, HeartPulse } from "lucide-react";
import { api } from "../api/client";
import type { JobRun, HealthStatus } from "../api/types";
import { Badge, statusTone, ErrorState, formatDate } from "../lib/ui";

function healthTone(level: string): "ok" | "warn" | "danger" {
  return level === "ok" ? "ok" : level === "warning" ? "warn" : "danger";
}

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
    mutationFn: (body: Record<string, any>) => api.put("/notifications", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); setSavedNotification(true); },
  });
  const [tmdbKeyDraft, setTmdbKeyDraft] = useState("");
  const [savedTmdb, setSavedTmdb] = useState(false);
  const saveTmdb = useMutation({
    mutationFn: (tmdbApiKey: string) => api.put("/system/config", { "metadata.tmdbApiKey": tmdbApiKey }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); setSavedTmdb(true); },
  });

  const runs = useQuery({ queryKey: ["job-runs"], queryFn: () => api.get<JobRun[]>("/system/jobs/runs") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<any[]>("/system/audit") });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<HealthStatus>("/system/health") });

  const trigger = useMutation({
    mutationFn: (jobKey: string) => api.post(`/system/commands/${jobKey}`),
    onSuccess: () => setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["job-runs"] });
      qc.invalidateQueries({ queryKey: ["health"] });
    }, 800),
  });

  const saveTheme = useMutation({
    mutationFn: (theme: string) => api.put("/system/config", { "ui.theme": theme }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const endpoints = [
    ["GET", "/api/v1/system/status"], ["GET", "/api/v1/system/config"], ["PUT", "/api/v1/system/config"],
    ["POST", "/api/v1/system/commands/:jobKey"], ["GET", "/api/v1/system/jobs"], ["GET", "/api/v1/system/jobs/runs"],
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
        <h2 className="text-2xl font-semibold tracking-tight">System</h2>
        <p className="text-sm text-zinc-500">Jobs, configuration, and API surface.</p>
      </div>

      {runs.isError && <ErrorState error={runs.error} onRetry={() => runs.refetch()} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-medium">Job runs</h3>
            <button onClick={() => trigger.mutate("system.healthCheck")} disabled={trigger.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50">
              <Play className="h-3.5 w-3.5" /> Run health check
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500 dark:text-zinc-400">
                <tr><th className="pb-2">Job</th><th className="pb-2">Status</th><th className="pb-2">Trigger</th><th className="pb-2">Attempt</th><th className="pb-2">Finished</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {runs.data?.slice(0, 15).map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 font-mono text-xs">{r.jobKey}</td>
                    <td className="py-2"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                    <td className="py-2 text-zinc-500">{r.trigger}</td>
                    <td className="py-2 text-zinc-500">{r.attempt}</td>
                    <td className="py-2 text-zinc-500">{formatDate(r.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="font-medium">Configuration</h3>
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-500">UI theme</span>
            <div className="flex gap-1 rounded-lg border border-zinc-300 p-1 dark:border-zinc-700">
              {(["dark", "light"] as const).map((t) => (
                <button key={t} onClick={() => { setThemeSetting(t); saveTheme.mutate(t); }}
                  className={`flex-1 rounded-md px-3 py-1 text-sm capitalize ${themeSetting === t || ((cfg.data as any)?.["ui.theme"]) === t ? "bg-violet-600 text-white" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}>
                  {t}
                </button>
              ))}
            </div>
          </label>
          <p className="text-xs text-zinc-500">Settings persist via the <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">setting</code> table. Endpoint inventory below reflects the native + compat API.</p>
        </section>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-medium"><HeartPulse className="h-4 w-4" /> Health</h3>
          {health.data?.checkedAt && <span className="text-xs text-zinc-500">Last checked {formatDate(health.data.checkedAt)}</span>}
        </div>
        {health.isError && <ErrorState error={health.error} onRetry={() => health.refetch()} />}
        {!health.isError && !health.data?.results.length && (
          <p className="text-sm text-zinc-500">No results yet — run a health check above.</p>
        )}
        {!!health.data?.results.length && (
          <div className="grid gap-2 sm:grid-cols-2">
            {health.data.results.map((r) => (
              <div key={r.key} className="flex items-start gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
                <Badge tone={healthTone(r.level)}>{r.level}</Badge>
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-zinc-500">{r.key}</p>
                  <p className="text-xs text-zinc-700 dark:text-zinc-300">{r.message}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-1 flex items-center gap-2 font-medium"><Database className="h-4 w-4" /> Metadata (TMDB)</h3>
        <p className="mb-3 text-xs text-zinc-500">
          Powers Discover and per-title metadata refresh. Get a free API key at{" "}
          <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="underline">themoviedb.org/settings/api</a>.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setSavedTmdb(false); saveTmdb.mutate(tmdbKeyDraft); }}
        >
          <input
            value={tmdbKeyDraft}
            onChange={(e) => setTmdbKeyDraft(e.target.value)}
            placeholder={cfg.data?.["metadata.tmdbApiKey"] ? "•••••••••••••••• (set — paste to replace)" : "TMDB API key"}
            className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
          />
          <button disabled={saveTmdb.isPending || !tmdbKeyDraft} className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {saveTmdb.isPending ? "Saving…" : "Save"}
          </button>
        </form>
        {savedTmdb && <p className="mt-2 text-xs text-emerald-600">Saved.</p>}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-1 flex items-center gap-2 font-medium"><Webhook className="h-4 w-4" /> Notifications</h3>
        <p className="mb-3 text-xs text-zinc-500">Webhook (JSON), Discord webhook, Telegram Bot, Email — alerts for grabs, imports, and indexer/download-client failures. Configure sinks with per-event subscriptions.</p>
        <div className="space-y-3">
          <form
            className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"
            onSubmit={(e) => { e.preventDefault(); const existing = (cfg.data?.["notifications.webhooks"] as any[]) ?? []; const eventTypes = notifyDraft.eventTypes ? notifyDraft.eventTypes.split(",").map((s) => s.trim()) : []; saveWebhooks.mutate({ webhooks: [...existing, { url: notifyDraft.url, secret: notifyDraft.secret || undefined, eventTypes }] }); setNotifyDraft({ url: "", secret: "", eventTypes: "" }); }}
          >
            <p className="mb-1 text-xs font-medium text-zinc-500">Add webhook</p>
            <div className="flex gap-2">
              <input required placeholder="https://hook.example/medianexus" value={notifyDraft.url} onChange={(e) => setNotifyDraft({ ...notifyDraft, url: e.target.value })} className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700" />
              <button className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">Add</button>
            </div>
          </form>
          <div className="grid gap-2 text-xs font-mono text-zinc-600 dark:text-zinc-300">
            <span>webhooks: {(cfg.data?.["notifications.webhooks"] as any[])?.length ?? 0}</span>
            <span>discord: {(cfg.data?.["notifications.discord"] as any[])?.length ?? 0}</span>
            <span>telegram: {(cfg.data?.["notifications.telegram"] as any[])?.length ?? 0}</span>
            <span>email: {(cfg.data?.["notifications.email"] as any[])?.length ?? 0}</span>
          </div>
          {savedNotification && <p className="text-xs text-emerald-600">Saved.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-3 font-medium">Audit trail</h3>
        {audit.isLoading ? <p className="text-sm text-zinc-500">Loading…</p> : audit.data?.length === 0 ? <p className="text-sm text-zinc-500">No audit entries.</p> : (
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {audit.data?.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-1.5 dark:border-zinc-700">
                <span className="truncate font-mono">{e.action}</span>
                <span className="text-zinc-500">{new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          <h3 className="font-medium">API key (for external tools)</h3>
        </div>
        <p className="mb-2 text-xs text-zinc-500">
          Your browser session doesn't need this — it's for configuring Sonarr/Radarr/Prowlarr-compatible clients or
          scripts against this instance's <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">/api/v1</code>{" "}
          (or compat) surface via the <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">X-Api-Key</code> header.
        </p>
        <button
          onClick={() => {
            if (!window.confirm("Regenerate the API key? The current key stops working immediately — anything using the old one (scripts, other tools) will need the new one.")) return;
            regenerateKey.mutate();
          }}
          disabled={regenerateKey.isPending}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
        >
          <RotateCw className={`h-3 w-3 ${regenerateKey.isPending ? "animate-spin" : ""}`} /> Regenerate key
        </button>
        {regenerateKey.isSuccess && <p className="mt-1 text-xs text-emerald-600">New key generated.</p>}
        {regenerateKey.isError && <p className="mt-1 text-xs text-red-600">{regenerateKey.error instanceof Error ? regenerateKey.error.message : "Failed to regenerate"}</p>}

        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          {revealedKey === undefined ? (
            <button
              onClick={() => revealKey.mutate()}
              disabled={revealKey.isPending}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
            >
              <Eye className="h-3 w-3" /> Reveal current key
            </button>
          ) : revealedKey === null ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              This key predates reveal support — regenerate it once above to enable revealing it later.
            </p>
          ) : (
            <div className="flex gap-2">
              <input
                readOnly
                value={revealedKey}
                className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm dark:border-zinc-700"
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(revealedKey).then(() => { setRevealCopied(true); setTimeout(() => setRevealCopied(false), 1500); });
                }}
                title="Copy to clipboard"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {revealCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => setRevealedKey(undefined)}
                title="Hide"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <EyeOff className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-1 flex items-center gap-2 font-medium"><Lock className="h-4 w-4" /> Change password</h3>
        <p className="mb-3 text-xs text-zinc-500">Changing your password signs out every other browser session — including anywhere else you're currently logged in.</p>
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
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
          />
          <input
            type="password"
            required
            placeholder="New password"
            value={passwordForm.next}
            onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })}
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
          />
          <div className="flex gap-2">
            <input
              type="password"
              required
              placeholder="Confirm new password"
              value={passwordForm.confirm}
              onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
              className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
            />
            <button disabled={changePassword.isPending} className="shrink-0 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
              {changePassword.isPending ? "Saving…" : "Update"}
            </button>
          </div>
        </form>
        {passwordError && <p className="mt-2 text-xs text-red-600 dark:text-red-500">{passwordError}</p>}
        {changePassword.isSuccess && <p className="mt-2 text-xs text-emerald-600">Password updated.</p>}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="mb-3 font-medium">API surface</h3>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {endpoints.map(([m, p]) => (
            <div key={`${m}-${p}`} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-xs dark:border-zinc-700">
              <span className={`font-semibold ${m === "GET" ? "text-emerald-600 dark:text-emerald-400" : m === "POST" ? "text-sky-600 dark:text-sky-400" : m === "PUT" ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"}`}>{m}</span>
              <span className="truncate text-zinc-600 dark:text-zinc-300">{p}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
