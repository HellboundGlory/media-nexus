// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { api, API_BASE } from "../api/client";
import { Badge, ErrorState, formatDate, formatBytes } from "../lib/ui";

const LEVELS = ["debug", "info", "warn", "error", "verbose"];

interface LogFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

function levelTone(level: string): "ok" | "warn" | "danger" | "neutral" {
  switch (level) {
    case "error": return "danger";
    case "warn": return "warn";
    case "debug":
    case "verbose": return "neutral";
    default: return "ok";
  }
}

export default function Logs() {
  const [level, setLevel] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");

  // Durable, rotating log files on disk (SON-035) — survive restarts, individually downloadable.
  const logFiles = useQuery({ queryKey: ["log-files"], queryFn: () => api.get<LogFileInfo[]>("/system/log-files") });

  const logs = useQuery({
    queryKey: ["logs", level, search],
    queryFn: () => {
      const q = new URLSearchParams({ limit: "300" });
      if (level) q.set("level", level);
      if (search) q.set("search", search);
      return api.get<{ timestamp: string; level: string; context: string; message: string }[]>(
        `/system/logs?${q.toString()}`,
      );
    },
  });

  return (
    <div className="space-y-6">
      {/* Durable log files on disk (SON-035) — the fast live-tail table below is the only
          in-memory part; these files are what survive a restart for post-crash diagnosis. */}
      <section className="rounded-xl border border-rule bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Download className="h-4 w-4 text-ink-dim" />
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Log files</h3>
        </div>
        <p className="mb-3 text-xs text-ink-dim">
          Durable, rotated log files on disk. They survive restarts (unlike the live tail below) and are
          redacted — download them here, or read them directly from the mounted data volume.
        </p>
        {logFiles.isError ? <ErrorState error={logFiles.error} onRetry={() => logFiles.refetch()} />
          : logFiles.data?.length === 0 ? <p className="text-sm text-ink-dim">No log files yet.</p>
          : (
            <div className="overflow-hidden rounded-lg border border-rule">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                  <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Created</th><th className="px-3 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {logFiles.data?.map((f) => (
                    <tr key={f.name}>
                      <td className="px-3 py-2 font-mono text-xs text-ink">{f.name}</td>
                      <td className="px-3 py-2 text-ink-dim">{formatBytes(f.sizeBytes)}</td>
                      <td className="px-3 py-2 text-ink-dim">{formatDate(f.createdAt)}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <a
                            href={`${API_BASE}/system/log-files/${encodeURIComponent(f.name)}/download`}
                            download
                            title="Download log file"
                            className="rounded-md p-1.5 text-ink-dim hover:bg-bg hover:text-ink"
                          >
                            <Download className="h-4 w-4" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <p className="text-xs text-ink-dim">
        The live view below shows the most recent buffered lines and clears on restart. The files
        above are durable, rotated logs that survive restarts — download them here, or read them
        directly from the mounted data volume.
        <code className="ml-1 rounded bg-neutral-bg px-1 text-ink">docker logs</code> holds the full, unredacted console history.
      </p>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-rule bg-surface p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-dim">Level</span>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="">All levels</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); setSearch(searchDraft.trim()); }}
        >
          <label className="block">
            <span className="mb-1 block text-xs text-ink-dim">Search</span>
            <input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="context or message substring"
              className="rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <button className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
            Filter
          </button>
        </form>
        <button
          onClick={() => logs.refetch()}
          disabled={logs.isFetching}
          className="flex items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-rule disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${logs.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
        <span className="text-xs text-ink-dim">{logs.data?.length ?? 0} shown</span>
      </div>

      <section className="rounded-xl border border-rule bg-surface p-4">
        {logs.isError && <ErrorState error={logs.error} onRetry={() => logs.refetch()} />}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
              <tr>
                <th className="pb-2 pr-3">When</th>
                <th className="pb-2 pr-3">Level</th>
                <th className="pb-2 pr-3">Context</th>
                <th className="pb-2">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {!!logs.data?.length && logs.data.map((e, i) => (
                <tr key={`${e.timestamp}-${i}`}>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-ink-dim">{formatDate(e.timestamp)}</td>
                  <td className="py-1.5 pr-3"><Badge tone={levelTone(e.level)}>{e.level}</Badge></td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">{e.context}</td>
                  <td className="py-1.5 font-mono text-xs break-all">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!logs.isError && !logs.data?.length && <p className="py-4 text-sm text-ink-dim">No log entries match.</p>}
        </div>
      </section>
    </div>
  );
}
