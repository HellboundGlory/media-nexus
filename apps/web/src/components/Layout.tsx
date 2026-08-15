// SPDX-License-Identifier: MIT
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Moon, Sun, LayoutDashboard, Compass, Film, Tv, Activity, ListTree, ScrollText, LogOut, Download, CalendarDays, FileText, Filter } from "lucide-react";
import { useAppStore, applyTheme } from "../store/useAppStore";
import { api } from "../api/client";
import type { SystemStatus, UpdateCheckState } from "../api/types";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/discover", label: "Discover", icon: Compass },
  { to: "/movies", label: "Movies", icon: Film },
  { to: "/series", label: "Series", icon: Tv },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/indexers", label: "Indexers", icon: ListTree },
  { to: "/clients", label: "Clients & Servers", icon: Download },
  { to: "/release-profiles", label: "Release Profiles", icon: Filter },
];

export default function Layout() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const navigate = useNavigate();
  // Version is sourced from the API's /system/status (which derives from root package.json at
  // runtime), not a hardcoded literal — released from the AGENTS.md release-sync checklist.
  const status = useQuery({ queryKey: ["system-status"], queryFn: () => api.get<SystemStatus>("/system/status") });
  const update = useQuery({ queryKey: ["update-check"], queryFn: () => api.get<UpdateCheckState>("/system/update-check") });
  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 md:flex">
        <div className="flex items-center gap-2 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-sm font-bold text-white">
            M
          </div>
          <span className="text-lg font-semibold tracking-tight">MediaNexus</span>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
          <NavLink
            to="/system"
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                isActive ? "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )
            }
          >
            <ScrollText className="h-4 w-4" /> System
          </NavLink>
          <NavLink
            to="/logs"
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium",
                isActive ? "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )
            }
          >
            <FileText className="h-4 w-4" /> Logs
          </NavLink>
        </nav>
        <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
          <button
            onClick={logout}
            className="mb-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <LogOut className="h-3.5 w-3.5" /> Logout
          </button>
          <div className="flex items-center justify-between rounded-lg px-2 py-1">
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              {status.data ? `v${status.data.version}` : "…"}
              {update.data?.updateAvailable && update.data.latestVersion && update.data.releaseUrl && (
                <a
                  href={update.data.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`Update available: v${update.data.latestVersion} → release page`}
                  className="rounded-full bg-violet-100 px-1.5 py-px text-[10px] font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-200 dark:hover:bg-violet-900/60"
                >
                  v{update.data.latestVersion} available
                </a>
              )}
            </span>
            <button
              onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white/80 px-5 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <h1 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 md:hidden">MediaNexus</h1>
          <div className="hidden text-xs text-zinc-500 md:block">Unified media automation platform</div>
          <button
            onClick={() => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); applyTheme(next); }}
            className="rounded-md p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 md:hidden"
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
