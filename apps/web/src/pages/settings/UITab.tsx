// SPDX-License-Identifier: MIT
// Settings > UI (NAV-1 Phase 4): the theme toggle, relocated from System's old Configuration
// section. Persists via ui.theme (PUT /system/config) and applies through the app's theme store.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAppStore, applyTheme } from "../../store/useAppStore";

export function UITab() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.get<Record<string, unknown>>("/system/config") });
  const saveTheme = useMutation({
    mutationFn: (t: string) => api.put("/system/config", { "ui.theme": t }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });

  const active = ConfigTheme(cfg, theme);

  return (
    <section className="rounded-xl border border-rule bg-surface p-4">
      <h3 className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">UI theme</h3>
      <p className="mb-3 text-xs text-ink-dim">Dark or light. Persists via the setting table and applies immediately.</p>
      <div className="flex gap-1 rounded-lg border border-rule bg-bg p-1 max-w-xs">
        {(["dark", "light"] as const).map((t) => (
          <button key={t} onClick={() => { setTheme(t); applyTheme(t); saveTheme.mutate(t); }}
            className={`flex-1 rounded-md px-3 py-1 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${active === t ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-surface hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>
    </section>
  );
}

function ConfigTheme(cfg: { data?: Record<string, unknown> }, storeTheme: string): string {
  const stored = cfg.data?.["ui.theme"];
  return typeof stored === "string" ? stored : storeTheme;
}
