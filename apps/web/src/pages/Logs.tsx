// SPDX-License-Identifier: MIT
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ScrollText } from "lucide-react";
import { api } from "../api/client";
import { Badge, ErrorState, formatDate } from "../lib/ui";

const LEVELS = ["debug", "info", "warn", "error", "verbose"];

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
      <div>
        <h2 className="flex items-center gap-2 font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">
          <ScrollText className="h-5 w-5" /> Logs
        </h2>
        <p className="text-sm text-ink-dim">
          Recent in-memory log lines. Redacted. In-memory only — a restart clears the buffer;
          <code className="ml-1 rounded bg-neutral-bg px-1 text-ink">docker logs</code> holds the full, unredacted history.
        </p>
      </div>

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
