// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Play, Webhook, Database } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { api } from "../api/client";
import type { JobRun } from "../api/types";
import { Badge, statusTone, ErrorState, formatDate } from "../lib/ui";

export default function System() {
  const qc = useQueryClient();
  const [themeSetting, setThemeSetting] = useState("");
  const apiKey = useAppStore((s) => s.apiKey);
  const setApiKey = useAppStore((s) => s.setApiKey);
  const [keyDraft, setKeyDraft] = useState(apiKey);
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

  const trigger = useMutation({
    mutationFn: (jobKey: string) => api.post(`/system/commands/${jobKey}`),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["job-runs"] }), 800),
  });

  const saveTheme = useMutation({
    mutationFn: (theme: string) => api.put("/system/config", { "ui.theme": theme }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const endpoints = [
    ["GET", "/api/v1/system/status"], ["GET", "/api/v1/system/config"], ["PUT", "/api/v1/system/config"],
    ["POST", "/api/v1/system/commands/:jobKey"], ["GET", "/api/v1/system/jobs"], ["GET", "/api/v1/system/jobs/runs"],
    ["GET", "/api/v1/movies"], ["POST", "/api/v1/movies"], ["GET", "/api/v1/series"], ["POST", "/api/v1/series"],
    ["GET", "/api/v1/series/:id/seasons"], ["POST", "/api/v1/search"], ["POST", "/api/v1/grabs"],
    ["GET", "/api/v1/indexers"], ["POST", "/api/v1/indexers"], ["GET", "/api/v1/indexers/definitions"],
    ["GET", "/api/v1/history"], ["GET", "/api/v1/queue"], ["GET", "/api/v1/auth/whoami"],
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
          <h3 className="font-medium">API key (this browser)</h3>
        </div>
        <p className="mb-2 text-xs text-zinc-500">
          First-run bootstrap prints an <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">X-Api-Key</code> to the API
          logs. Paste it here so this browser can call the API (stored locally only). In dev you can also set
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800"> VITE_MEDIA_NEXUS_API_KEY </code> in{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">apps/web/.env</code>.
        </p>
        <div className="flex gap-2">
          <input
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { setApiKey(keyDraft.trim()); qc.invalidateQueries(); } }}
            placeholder="mn_…"
            className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-zinc-700"
          />
          <button
            onClick={() => { setApiKey(keyDraft.trim()); setTimeout(() => qc.invalidateQueries(), 150); }}
            className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
          >
            Save key
          </button>
        </div>
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
