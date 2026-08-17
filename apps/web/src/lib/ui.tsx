// SPDX-License-Identifier: MIT
import { type ReactNode } from "react";
import { clsx } from "clsx";
import { Loader2 , Inbox, AlertTriangle } from "lucide-react";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-dim" role="status">
      <Loader2 className="h-4 w-4 animate-spin" /> {label ?? "Loading…"}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-rule bg-surface px-6 py-12 text-center">
      <Inbox className="h-8 w-8 text-ink-dim" />
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-sm text-ink-dim">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-err/40 bg-err-bg px-4 py-3 text-sm text-err-ink">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        <span>{msg}</span>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="rounded-md px-2 py-1 text-xs font-medium text-err-ink hover:bg-err-bg">
          Retry
        </button>
      )}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "info" }) {
  const tones: Record<string, string> = {
    neutral: "bg-neutral-bg text-neutral-ink",
    ok: "bg-ok-bg text-ok-ink",
    warn: "bg-warn-bg text-warn-ink",
    danger: "bg-err-bg text-err-ink",
    info: "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent",
  };
  return (
    <span className={clsx("inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", tones[tone])}>{children}</span>
  );
}

/** Renders the custom formats a release/file/queue/history row matched as small badges
 *  (SON-024). Accepts the optional `{id,name}[]` a caller reads out of `data`/`matchedFormats`
 *  (defensively — older rows / files with no probe lack it) and renders "—" when empty/absent. */
export function FormatsBadges({ formats }: { formats?: { id: string; name: string }[] }) {
  if (!formats || formats.length === 0) return <span className="text-ink-dim">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {formats.map((f) => <Badge key={f.id} tone="info">{f.name}</Badge>)}
    </span>
  );
}

export function statusTone(status: string): "ok" | "warn" | "danger" | "info" | "neutral" {
  switch (status) {
    case "available": case "succeeded": case "imported": case "ok": return "ok";
    case "downloading": case "processing": case "approved": case "running": case "queued": case "retrying": return "info";
    case "failed": case "download_failed": case "declined": case "error": return "danger";
    case "pending": case "unknown": case "stalled": return "warn";
    default: return "neutral";
  }
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <p className="font-display text-xs font-medium uppercase tracking-[0.04em] text-ink-dim">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold uppercase tracking-[0.05em] tabular-nums text-accent">{value}</p>
      {hint && <p className="text-xs text-ink-dim">{hint}</p>}
    </div>
  );
}

/**
 * StatusLamp — a small glowing dot + label for REAL health/status signals
 * (queue item status, indexer/download-client connectivity, provider health).
 * Not a decorative badge: attach it only where a genuine signal exists.
 * Dark theme gets a soft glow; light theme uses a ring (glow reads washed-out
 * on white — confirmed in the approved mockup).
 */
export type LampTone = "ok" | "warn" | "err" | "neutral";

export function StatusLamp({ tone = "neutral", label, className }: { tone?: LampTone; label?: ReactNode; className?: string }) {
  const dot: Record<LampTone, string> = {
    ok: "bg-ok shadow-[0_0_0_2px_var(--ok)] dark:shadow-[0_0_7px_1px_var(--ok)]",
    warn: "bg-warn shadow-[0_0_0_2px_var(--warn)] dark:shadow-[0_0_7px_1px_var(--warn)]",
    err: "bg-err shadow-[0_0_0_2px_var(--err)] dark:shadow-[0_0_7px_1px_var(--err)]",
    neutral: "bg-ink-dim shadow-[0_0_0_2px_var(--ink-dim)] dark:shadow-[0_0_7px_1px_var(--ink-dim)]",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1.5", className)} role="status">
      <span className={clsx("h-2 w-2 rounded-full", dot[tone])} />
      {label != null && <span className="text-xs font-medium text-ink-dim">{label}</span>}
    </span>
  );
}

/**
 * ProgressBar — segmented "VU-meter" fill (repeating 4px segments with 1px gap)
 * over the --track background, not a smooth gradient. Replaces the ad-hoc
 * violet bar in Activity.tsx.
 */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className={clsx("h-2 w-24 overflow-hidden rounded-sm bg-track", className)}>
      <div
        className="h-full"
        style={{
          width: `${pct}%`,
          backgroundImage:
            "repeating-linear-gradient(90deg, var(--accent) 0 4px, transparent 4px 5px)",
        }}
      />
    </div>
  );
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
