// SPDX-License-Identifier: MIT
// System > Updates (NAV-1 Phase 4): update-check state from GET /system/update-check (the same
// query already powers the sidebar badge). Read-only — no self-updater exists.
import { useQuery } from "@tanstack/react-query";
import { PackageCheck, Rocket } from "lucide-react";
import { api } from "../../api/client";
import type { UpdateCheckState } from "../../api/types";
import { Badge, ErrorState } from "../../lib/ui";

export function UpdatesTab() {
  const update = useQuery({ queryKey: ["update-check"], queryFn: () => api.get<UpdateCheckState>("/system/update-check") });
  const u = update.data;

  return (
    <div className="space-y-4">
      {update.isError ? <ErrorState error={update.error} onRetry={() => update.refetch()} /> : !u ? <p className="text-sm text-ink-dim">Loading…</p> : (
        <section className="rounded-xl border border-rule bg-surface p-4">
          <div className="flex items-center gap-2">
            {u.updateAvailable ? <Rocket className="h-4 w-4 text-accent" /> : <PackageCheck className="h-4 w-4 text-ok" />}
            <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Update status</h3>
          </div>
          <div className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            <div className="rounded-lg border border-rule bg-bg px-3 py-2"><p className="text-[10px] uppercase text-ink-dim">Current version</p><p className="font-medium text-ink">{u.checked ? u.currentVersion : "—"}</p></div>
            <div className="rounded-lg border border-rule bg-bg px-3 py-2"><p className="text-[10px] uppercase text-ink-dim">Latest version</p><p className="font-medium text-ink">{u.checked && u.latestVersion ? u.latestVersion : "—"}</p></div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Badge tone={u.checked && u.updateAvailable ? "warn" : "ok"}>{u.checked ? (u.updateAvailable ? "update available" : "up to date") : "not checked"}</Badge>
            {u.checked && u.updateAvailable && u.releaseUrl && (
              <a href={u.releaseUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent underline">View release →</a>
            )}
          </div>
          <p className="mt-3 text-xs text-ink-dim">Read-only — MediaNexus is deployed as a container; update by pulling a newer image and restarting, not in-app.</p>
        </section>
      )}
    </div>
  );
}
