// SPDX-License-Identifier: MIT
// System > Events (NAV-1 Phase 4): the audit trail, relocated verbatim from the old System page.
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { api } from "../../api/client";
import { ErrorState } from "../../lib/ui";

interface AuditEntry {
  id: string;
  action: string;
  createdAt: string;
}

export function EventsTab() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditEntry[]>("/system/audit") });
  return (
    <section className="rounded-xl border border-rule bg-surface p-4">
      <h3 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><ScrollText className="h-4 w-4" /> Audit trail</h3>
      {audit.isError ? <ErrorState error={audit.error} onRetry={() => audit.refetch()} /> : (audit.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-dim">No audit entries.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
          {audit.data?.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg px-3 py-1.5">
              <span className="truncate font-mono">{e.action}</span>
              <span className="text-ink-dim">{new Date(e.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
