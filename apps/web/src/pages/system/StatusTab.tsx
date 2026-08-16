// SPDX-License-Identifier: MIT
// System > Status (NAV-1 Phase 4): health checks, an About block (version/db/uptime from
// /system/status), and a clearly-labeled "Diagnostics" section holding two MediaNexus-specific
// dev tools with no upstream equivalent (the release-title parser and the API-surface inventory).
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { HeartPulse, Database } from "lucide-react";
import { api } from "../../api/client";
import type { HealthStatus, SystemStatus } from "../../api/types";
import { Badge, ErrorState, formatDate } from "../../lib/ui";

function healthTone(level: string): "ok" | "warn" | "danger" {
  return level === "ok" ? "ok" : level === "warning" ? "warn" : "danger";
}

const monoInputCls = "flex-1 rounded-lg border border-rule bg-transparent px-3 py-1.5 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

const endpoints: [string, string][] = [
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

export function StatusTab() {
  const status = useQuery({ queryKey: ["system-status"], queryFn: () => api.get<SystemStatus>("/system/status") });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<HealthStatus>("/system/health") });
  const [parseTitle, setParseTitle] = useState("");
  const parse = useMutation({ mutationFn: (title: string) => api.get<any>(`/system/parse?title=${encodeURIComponent(title)}`) });

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><HeartPulse className="h-4 w-4" /> Health</h3>
          {health.data?.checkedAt && <span className="text-xs text-ink-dim">Last checked {formatDate(health.data.checkedAt)}</span>}
        </div>
        {health.isError ? <ErrorState error={health.error} onRetry={() => health.refetch()} />
          : !health.data?.results.length ? <p className="text-sm text-ink-dim">No health results yet.</p>
          : (
            <div className="grid gap-2 sm:grid-cols-2">
              {health.data.results.map((r) => (
                <div key={r.key} className="flex items-start gap-2 rounded-lg border border-rule bg-bg px-3 py-2">
                  <Badge tone={healthTone(r.level)}>{r.level}</Badge>
                  <div className="min-w-0"><p className="truncate font-mono text-xs text-ink-dim">{r.key}</p><p className="text-xs text-ink">{r.message}</p></div>
                </div>
              ))}
            </div>
          )}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><Database className="h-4 w-4" /> About</h3>
        <div className="grid gap-1.5 text-sm sm:grid-cols-3">
          <div className="rounded-lg border border-rule bg-bg px-3 py-2"><p className="text-[10px] uppercase text-ink-dim">Version</p><p className="font-medium text-ink">{status.data?.version ?? "—"}</p></div>
          <div className="rounded-lg border border-rule bg-bg px-3 py-2"><p className="text-[10px] uppercase text-ink-dim">Database</p><p className="font-medium text-ink">{status.data?.database.vendor ?? "—"}</p></div>
          <div className="rounded-lg border border-rule bg-bg px-3 py-2"><p className="text-[10px] uppercase text-ink-dim">Uptime</p><p className="font-medium text-ink">{status.data ? `${Math.floor(status.data.uptimeSeconds / 60)}m` : "—"}</p></div>
        </div>
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Diagnostics <span className="ml-1 text-[10px] font-normal normal-case text-ink-dim/70">(MediaNexus-specific dev tools — no upstream equivalent)</span></h3>
        <p className="mb-3 text-xs text-ink-dim">Run a raw release title through the parsers to see what was extracted and why it might not match your library.</p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (parseTitle.trim()) parse.mutate(parseTitle.trim()); }}>
          <input value={parseTitle} onChange={(e) => setParseTitle(e.target.value)} placeholder="Show.Name.S01E02.1080p.WEB-DL.x264-GROUP" className={monoInputCls} />
          <button disabled={parse.isPending || !parseTitle.trim()} className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{parse.isPending ? "Parsing…" : "Parse"}</button>
        </form>
        {parse.isError && <p className="mt-2 text-xs text-err">{parse.error instanceof Error ? parse.error.message : "Failed to parse"}</p>}
        {parse.data && <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-rule bg-bg p-3 text-xs leading-relaxed text-ink">{JSON.stringify(parse.data, null, 2)}</pre>}
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
