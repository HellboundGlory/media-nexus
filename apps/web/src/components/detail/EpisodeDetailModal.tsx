// SPDX-License-Identifier: MIT
// EpisodeDetailModal (EPISODEDETAIL-1, Tier 1 item 6) — opened by clicking an episode row on the
// Series detail page. Three tabs: Details / History / Search, matching Sonarr's own episode
// modal. The matched file row and the two search triggers are supplied by the caller (the page
// already has the files list and the per-episode auto-search / interactive-search handlers) —
// this component fetches nothing itself beyond HistoryPanel's own history query.
import { useState } from "react";
import { Modal } from "../Modal";
import { Badge, formatDate, formatBytes, FormatsBadges } from "../../lib/ui";
import { MediaFileActions } from "./MediaFileActions";
import { HistoryPanel } from "./HistoryPanel";
import { episodeFinaleBadge } from "../../lib/episodeFinale";
import type { Episode, MediaFileRow } from "../../api/types";

type Tab = "details" | "history" | "search";

const tabCls = (active: boolean) =>
  `-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
    active ? "border-accent text-accent" : "border-transparent text-ink-dim hover:text-ink"
  }`;

export function EpisodeDetailModal({
  seriesTitle,
  seasonNumber,
  episode,
  qualityProfileName,
  matchedFile,
  maxSeasonNumber,
  onClose,
  onQuickSearch,
  onInteractiveSearch,
  onFileChanged,
}: {
  seriesTitle: string;
  seasonNumber: number;
  episode: Episode;
  qualityProfileName: string;
  matchedFile?: MediaFileRow;
  maxSeasonNumber: number;
  onClose: () => void;
  onQuickSearch: () => void;
  onInteractiveSearch: () => void;
  onFileChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("details");
  const finale = episodeFinaleBadge(episode.episodeType, seasonNumber, maxSeasonNumber);

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span>
            {seriesTitle} · S{String(seasonNumber).padStart(2, "0")}E{String(episode.episodeNumber).padStart(2, "0")} · {episode.title || "—"}
          </span>
          {finale && <Badge tone="info">{finale}</Badge>}
        </span>
      }
    >
      <div className="border-b border-rule px-4 pt-2">
        <nav className="flex gap-1 border-b border-rule" aria-label="Episode">
          {(["details", "history", "search"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={tabCls(tab === t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </div>

      <div className="p-4">
        {tab === "details" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Airs</p>
                <p className="text-sm text-ink">{episode.airDateUtc ? formatDate(episode.airDateUtc).slice(0, 10) : "—"}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Quality Profile</p>
                <p className="text-sm text-ink">{qualityProfileName}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Monitored</p>
                <p className="text-sm text-ink"><Badge tone={episode.monitored ? "ok" : "neutral"}>{episode.monitored ? "Monitored" : "Unmonitored"}</Badge></p>
              </div>
            </div>

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">Overview</p>
              <p className="text-sm text-ink-dim">{episode.overview || "—"}</p>
            </div>

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-dim">File</p>
              {matchedFile ? (
                <table className="w-full text-left text-sm">
                  <thead className="bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
                    <tr>
                      <th className="px-3 py-2">Path</th>
                      <th className="px-3 py-2">Size</th>
                      <th className="px-3 py-2">Quality</th>
                      <th className="px-3 py-2">Formats</th>
                      <th className="px-3 py-2">Languages</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    <tr>
                      <td className="max-w-[20rem] truncate px-3 py-2 font-mono text-xs" title={matchedFile.relativePath}>{matchedFile.relativePath}</td>
                      <td className="px-3 py-2 tabular-nums text-ink-dim">{formatBytes(matchedFile.size)}</td>
                      <td className="px-3 py-2 text-ink-dim">{matchedFile.quality ? `${matchedFile.quality.source} · ${matchedFile.quality.resolution}` : "—"}</td>
                      <td className="px-3 py-2"><FormatsBadges formats={matchedFile.matchedFormats} /></td>
                      <td className="px-3 py-2 text-ink-dim">{matchedFile.languages.length ? matchedFile.languages.join(", ") : "—"}</td>
                      <td className="px-3 py-2 text-right"><MediaFileActions file={matchedFile} onChanged={onFileChanged} /></td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div className="rounded-lg border border-dashed border-rule p-6 text-center text-sm text-ink-dim">No file yet</div>
              )}
            </div>
          </div>
        )}

        {tab === "history" && (
          <HistoryPanel mediaType="series" mediaId={episode.seriesId} episodeId={episode.id} />
        )}

        {tab === "search" && (
          <div className="flex h-40 flex-col items-center justify-center gap-3">
            <button
              onClick={() => { onQuickSearch(); onClose(); }}
              className="rounded-lg border border-rule bg-bg px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-ink hover:bg-rule"
            >
              Quick Search
            </button>
            <button
              onClick={() => { onInteractiveSearch(); onClose(); }}
              className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"
            >
              Interactive Search
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
