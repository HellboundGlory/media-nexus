// SPDX-License-Identifier: MIT
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Moon, Sun, LayoutDashboard, Compass, Film, Tv, Activity, ListTree, ScrollText, LogOut, Download, CalendarDays, FileText, Filter, Tags, FolderOpen } from "lucide-react";
import { useAppStore, applyTheme } from "../store/useAppStore";
import { api } from "../api/client";
import type { SystemStatus, UpdateCheckState, HealthStatus } from "../api/types";
import { StatusLamp, type LampTone } from "../lib/ui";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/discover", label: "Discover", icon: Compass },
  { to: "/import", label: "Import", icon: FolderOpen },
  { to: "/movies", label: "Movies", icon: Film },
  { to: "/series", label: "Series", icon: Tv },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/indexers", label: "Indexers", icon: ListTree },
  { to: "/clients", label: "Clients & Servers", icon: Download },
  { to: "/release-profiles", label: "Release Profiles", icon: Filter },
  { to: "/auto-tags", label: "Auto Tags", icon: Tags },
];

/** Map the real overall-health signal onto a lamp tone. */
function healthTone(overall?: string): LampTone {
  switch (overall) {
    case "ok": return "ok";
    case "warning": return "warn";
    case "error": return "err";
    default: return "neutral";
  }
}

export default function Layout() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const navigate = useNavigate();
  // Version sourced from the API (derives from root package.json at runtime), not a literal.
  const status = useQuery({ queryKey: ["system-status"], queryFn: () => api.get<SystemStatus>("/system/status") });
  const update = useQuery({ queryKey: ["update-check"], queryFn: () => api.get<UpdateCheckState>("/system/update-check") });
  // Genuine status signal: overall system health (ok / warning / error) — drives the
  // StatusLamp on the System item. No dot elsewhere: no other nav item has a real
  // signal wired to it yet, and a lamp without real data is a fake control.
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<HealthStatus>("/system/health") });
  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    navigate("/login", { replace: true });
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      "flex items-center gap-3 rounded-md px-3 py-2 font-display text-sm font-medium uppercase tracking-[0.04em] transition-colors",
      isActive
        ? "bg-accent/15 text-accent"
        : "text-ink-dim hover:bg-surface hover:text-ink",
    );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-rule bg-surface md:flex">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent font-display text-lg font-bold text-accent-ink">
            M
          </div>
          <span className="font-display text-lg font-bold uppercase tracking-[0.05em] text-accent">MediaNexus</span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-2">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
          <NavLink to="/system" className={navClass}>
            <ScrollText className="h-4 w-4" /> System
            <StatusLamp tone={healthTone(health.data?.overall)} className="ml-auto" />
          </NavLink>
          <NavLink to="/logs" className={navClass}>
            <FileText className="h-4 w-4" /> Logs
          </NavLink>
        </nav>
        <div className="border-t border-rule p-3">
          <button
            onClick={logout}
            className="mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-dim hover:bg-bg hover:text-ink"
          >
            <LogOut className="h-3.5 w-3.5" /> Logout
          </button>
          <div className="flex items-center justify-between rounded-md px-2 py-1">
            <span className="flex items-center gap-1.5 text-xs text-ink-dim">
              {status.data ? `v${status.data.version}` : "…"}
              {update.data?.updateAvailable && update.data.latestVersion && update.data.releaseUrl && (
                <a
                  href={update.data.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`Update available: v${update.data.latestVersion} → release page`}
                  className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-medium text-accent hover:bg-accent/25"
                >
                  v{update.data.latestVersion} available
                </a>
              )}
            </span>
            <button
              onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
              className="rounded-md p-1.5 text-ink-dim hover:bg-bg"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-bg/80 px-5 py-3 backdrop-blur">
          <h1 className="font-display text-sm font-medium uppercase tracking-[0.04em] text-ink md:hidden">MediaNexus</h1>
          <div className="hidden font-display text-xs font-medium uppercase tracking-[0.04em] text-ink-dim md:block">Unified media automation platform</div>
          <button
            onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
            className="rounded-md p-2 text-ink-dim hover:bg-surface md:hidden"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </header>
        <main className="flex-1 p-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
