// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { api } from "../api/client";
import type { JobRun } from "../api/types";
import { Badge, statusTone, ErrorState, formatDate } from "../lib/ui";

export default function System() {
  const qc = useQueryClient();
  const [themeSetting, setThemeSetting] = useState("");

  const runs = useQuery({ queryKey: ["job-runs"], queryFn: () => api.get<JobRun[]>("/system/jobs/runs") });
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });

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
    ["GET", "/api/v1/history"], ["GET", "/api/v1/queue"], ["GET", "/api/v1/requests"], ["POST", "/api/v1/requests"],
    ["POST", "/api/v1/requests/:id/approve"], ["POST", "/api/v1/requests/:id/decline"], ["GET", "/api/v1/auth/whoami"],
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
