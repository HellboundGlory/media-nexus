// SPDX-License-Identifier: MIT
// MonitoredLamp — icon-only monitored lamp (no text label, per the last mockup round). Clicking
// toggles the media type's monitored flag via PUT /movies|series/:id { monitored }. The caller
// owns the mutation+invalidation; this is a thin presentational+trigger component so both detail
// pages share one implementation.
import { Eye, EyeOff } from "lucide-react";
import { clsx } from "clsx";

export function MonitoredLamp({
  monitored,
  onToggle,
  busy,
}: {
  monitored: boolean;
  onToggle: () => void;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      title={monitored ? "Monitored — click to unmonitor" : "Unmonitored — click to monitor"}
      aria-pressed={monitored}
      className={clsx(
        "inline-flex h-8 w-8 items-center justify-center rounded border transition-colors disabled:opacity-50",
        monitored ? "border-ok bg-ok/15 text-ok" : "border-rule bg-bg text-ink-dim hover:border-ink-dim",
      )}
    >
      {monitored ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </button>
  );
}
