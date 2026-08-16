// SPDX-License-Identifier: MIT
// Settings > Connect (NAV-1 Phase 4, closes SON-027's missing-kinds gap): notification sinks for
// all four kinds (webhook / discord / telegram / email), relocated from System's old webhook-only
// form and extended. Schemas live in packages/shared/src/settings.ts; the backend already accepts
// every kind via the existing POST /notifications. Existing sinks are listed grouped by kind.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Bell } from "lucide-react";
import { api } from "../../api/client";
import { EmptyState, ErrorState, Badge } from "../../lib/ui";

type Kind = "webhook" | "discord" | "telegram" | "email";
const KIND_LABEL: Record<Kind, string> = { webhook: "Webhook", discord: "Discord", telegram: "Telegram", email: "Email" };

interface NotificationSink { id: string; kind: string; name: string; enabled: boolean; eventTypes: string[]; settings: Record<string, unknown> }

const inputCls = "w-full rounded-lg border border-rule bg-transparent px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ConnectTab() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("webhook");
  const [d, setD] = useState<Record<string, string>>({});

  const notifications = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<NotificationSink[]>("/notifications") });
  const refetch = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const create = useMutation({
    mutationFn: async () => {
      const eventTypes = (d.eventTypes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const settings: Record<string, unknown> = {};
      if (kind === "webhook") { settings.url = d.url; if (d.secret) settings.secret = d.secret; }
      else if (kind === "discord") { settings.webhookUrl = d.webhookUrl; }
      else if (kind === "telegram") { settings.botToken = d.botToken; settings.chatId = d.chatId; if (d.baseUrl) settings.baseUrl = d.baseUrl; }
      else if (kind === "email") {
        settings.from = d.from;
        settings.to = (d.to ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        settings.transport = { host: d.host, port: Number(d.port || 587), secure: d.secure === "1", auth: d.authUser ? { user: d.authUser, pass: d.authPass } : undefined };
        settings.subject = d.subject || undefined;
      }
      await api.post("/notifications", { kind, eventTypes, settings });
    },
    onSuccess: () => { refetch(); setD({}); },
  });

  const remove = useMutation({ mutationFn: (id: string) => api.del(`/notifications/${id}`), onSuccess: refetch });

  const set = (k: string, v: string) => setD((p) => ({ ...p, [k]: v }));
  const rows = notifications.data ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim"><Bell className="h-4 w-4" /> Connect</h3>
        <p className="mb-3 text-xs text-ink-dim">Notification sinks for grabs, imports, and failures. Configure per-event subscriptions (comma-separated event types).</p>

        <div className="mb-3 flex w-fit gap-1 rounded-lg border border-rule bg-bg p-1">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button key={k} onClick={() => { setKind(k); setD({}); }}
              className={`rounded-md px-3 py-1 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${kind === k ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-surface hover:text-ink"}`}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="grid gap-2 rounded-lg border border-rule bg-bg p-3 sm:grid-cols-2">
          {kind === "webhook" && (
            <>
              <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-ink-dim">URL</span><input value={d.url ?? ""} onChange={(e) => set("url", e.target.value)} placeholder="https://hook.example/medianexus" className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Secret (optional)</span><input value={d.secret ?? ""} onChange={(e) => set("secret", e.target.value)} className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Event types (comma-separated)</span><input value={d.eventTypes ?? ""} onChange={(e) => set("eventTypes", e.target.value)} placeholder="acquisition.release.grabbed, acquisition.import.completed" className={inputCls} /></label>
            </>
          )}
          {kind === "discord" && (
            <>
              <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-ink-dim">Webhook URL</span><input value={d.webhookUrl ?? ""} onChange={(e) => set("webhookUrl", e.target.value)} placeholder="https://discord.com/api/webhooks/..." className={inputCls} /></label>
              <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-ink-dim">Event types (comma-separated)</span><input value={d.eventTypes ?? ""} onChange={(e) => set("eventTypes", e.target.value)} className={inputCls} /></label>
            </>
          )}
          {kind === "telegram" && (
            <>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Bot token</span><input value={d.botToken ?? ""} onChange={(e) => set("botToken", e.target.value)} className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Chat id</span><input value={d.chatId ?? ""} onChange={(e) => set("chatId", e.target.value)} placeholder="123456789" className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Base URL (optional)</span><input value={d.baseUrl ?? ""} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://api.telegram.org" className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Event types (comma-separated)</span><input value={d.eventTypes ?? ""} onChange={(e) => set("eventTypes", e.target.value)} className={inputCls} /></label>
            </>
          )}
          {kind === "email" && (
            <>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">From</span><input value={d.from ?? ""} onChange={(e) => set("from", e.target.value)} placeholder="media@example.com" className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">To (comma-separated)</span><input value={d.to ?? ""} onChange={(e) => set("to", e.target.value)} className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">SMTP host</span><input value={d.host ?? ""} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Port</span><input value={d.port ?? "587"} onChange={(e) => set("port", e.target.value)} className={inputCls} /></label>
              <label className="block sm:col-span-2"><span className="mb-1 block text-xs text-ink-dim">Subject</span><input value={d.subject ?? ""} onChange={(e) => set("subject", e.target.value)} placeholder="MediaNexus notification" className={inputCls} /></label>
              <label className="flex items-center gap-2 text-sm text-ink-dim"><input type="checkbox" checked={d.secure === "1"} onChange={(e) => set("secure", e.target.checked ? "1" : "0")} className="h-4 w-4" /> Secure (TLS)</label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Auth user (optional)</span><input value={d.authUser ?? ""} onChange={(e) => set("authUser", e.target.value)} className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs text-ink-dim">Auth password (optional)</span><input type="password" value={d.authPass ?? ""} onChange={(e) => set("authPass", e.target.value)} className={inputCls} /></label>
            </>
          )}
        </div>

        <button onClick={() => create.mutate()} disabled={create.isPending} className="mt-3 rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50">{create.isPending ? "Saving…" : `Add ${KIND_LABEL[kind]}`}</button>
        {create.isError && <p className="mt-2 text-xs text-err">{create.error instanceof Error ? create.error.message : "Failed"}</p>}
      </section>

      <section className="rounded-xl border border-rule bg-surface p-4">
        <h3 className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Configured sinks</h3>
        {notifications.isError ? <ErrorState error={notifications.error} onRetry={() => notifications.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No notification sinks" hint="Add one above to get alerts for grabs, imports and failures." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-rule">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                <tr><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Enabled</th><th className="px-3 py-2">Event types</th><th className="px-3 py-2 text-right">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {rows.map((n) => (
                  <tr key={n.id} className="hover:bg-bg/60">
                    <td className="px-3 py-2"><Badge tone="neutral">{n.kind}</Badge></td>
                    <td className="px-3 py-2 font-medium text-ink">{n.name || n.kind}</td>
                    <td className="px-3 py-2"><Badge tone={n.enabled === false ? "warn" : "ok"}>{n.enabled === false ? "disabled" : "enabled"}</Badge></td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-ink-dim">{(n.eventTypes ?? []).join(", ") || "—"}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => remove.mutate(n.id)} className="rounded p-1 text-ink-dim hover:bg-err-bg hover:text-err" title="Remove"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
