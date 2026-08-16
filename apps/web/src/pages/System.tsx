// SPDX-License-Identifier: MIT
// System — tabbed admin destination (NAV-1 Phase 4), split into 6 tabs matching upstream:
// Status, Tasks, Backup, Updates, Events, Log Files. Every configuration-shaped section that
// used to live here (theme, TMDB metadata, notifications, API key, change password) has moved
// to Settings (UI / Metadata Source / Connect / General). Tab selection is local state (same
// pattern as Activity/Settings), not URL-backed routes.
import { useState } from "react";
import { StatusTab } from "./system/StatusTab";
import { TasksTab } from "./system/TasksTab";
import { BackupTab } from "./system/BackupTab";
import { UpdatesTab } from "./system/UpdatesTab";
import { EventsTab } from "./system/EventsTab";
import Logs from "./Logs";

const TABS = [
  { id: "status", label: "Status" },
  { id: "tasks", label: "Tasks" },
  { id: "backup", label: "Backup" },
  { id: "updates", label: "Updates" },
  { id: "events", label: "Events" },
  { id: "logfiles", label: "Log Files" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function System() {
  const [tab, setTab] = useState<TabId>("status");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">System</h2>
        <p className="text-sm text-ink-dim">Runtime status, scheduled tasks, backups, and logs.</p>
      </div>

      <div className="flex w-fit flex-wrap gap-1 rounded-lg border border-rule bg-surface p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-md px-4 py-1.5 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${tab === t.id ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "status" && <StatusTab />}
      {tab === "tasks" && <TasksTab />}
      {tab === "backup" && <BackupTab />}
      {tab === "updates" && <UpdatesTab />}
      {tab === "events" && <EventsTab />}
      {tab === "logfiles" && <Logs />}
    </div>
  );
}
