// SPDX-License-Identifier: MIT
// ProviderCard — the card-grid cell for indexers / download clients / media servers
// (UNI-018, approved mockup). Shows name, a mono sub-line (implementation · protocol/kind ·
// priority) and a badge row (enabled, protocol, health status, tags). A failing provider
// shows its status badge in the err tone with `lastError` as the title attribute. The whole
// card is one click target that opens the edit modal.
import { Star, Tag } from "lucide-react";
import { Badge, statusTone } from "../lib/ui";
import type { TagRow } from "../api/types";

export type ProviderKind = "indexer" | "downloadClient" | "mediaServer";

export function ProviderCard({
  name,
  subLine,
  enabled,
  protocol,
  status,
  lastError,
  tags,
  isDefault,
  tagLookup,
  onClick,
}: {
  name: string;
  subLine: string;
  enabled: boolean;
  protocol?: string;
  status?: string;
  lastError?: string | null;
  tags?: string[];
  isDefault?: boolean;
  tagLookup?: Map<string, TagRow>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-xl border border-rule bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-bg"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex items-center gap-1.5 font-medium text-ink">
          {isDefault && <Star className="h-3.5 w-3.5 shrink-0 fill-accent text-accent" />}
          <span className="truncate">{name}</span>
        </span>
        <Badge tone={enabled ? "ok" : "warn"}>{enabled ? "enabled" : "disabled"}</Badge>
      </div>
      <p className="truncate font-mono text-xs text-ink-dim">{subLine}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {protocol && <Badge tone="neutral">{protocol}</Badge>}
        {status && (
          <span title={status === "error" || status === "failed" ? (lastError ?? undefined) : undefined}>
            <Badge tone={status === "error" || status === "failed" ? "danger" : statusTone(status)}>{status}</Badge>
          </span>
        )}
        {(tags ?? []).map((id) => {
          const tag = tagLookup?.get(id);
          return (
            <span
              key={id}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink"
              style={tag?.color ? { backgroundColor: `color-mix(in_srgb, ${tag.color} 18%, transparent)` } : { backgroundColor: "var(--rule)" }}
            >
              <Tag className="h-2.5 w-2.5" />
              {tag?.label ?? id}
            </span>
          );
        })}
        {(tags ?? []).length === 0 && <span className="text-[10px] uppercase tracking-wide text-ink-dim/50">no tags</span>}
      </div>
    </button>
  );
}
