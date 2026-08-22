// SPDX-License-Identifier: MIT
// ManageFilesModal — the rebuilt Manage Files (movie) / Manage Episodes (series) table
// (MANAGEFILES-1), full Sonarr/Radarr InteractiveImportModal parity. Unlike the old
// reconcile-only screen, this performs a real folder rescan merging tracked + untracked files
// into ONE table (the backend's `items`), with per-cell click-to-edit pickers (Season,
// Episode(s), Release Group, Quality, Languages, Release Type, Indexer Flags), a bulk "Select…"
// bar (season-locked Episode(s), exact-even-split episode distribution), Custom Formats +
// Rejections icon columns, and Delete/Import actions.
//
// One deliberate, Hellbound-approved divergence from upstream: an empty optional/required cell
// ALWAYS shows its dashed hint (dimmed when unselected, full-strength once checked) instead of
// upstream's "invisible until the row is checked" — nothing is ever invisible-but-clickable.
// Do not "correct" this back to upstream during review.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Download, Flag, Star, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import {
  INDEXER_FLAGS,
  indexerFlagLabels,
  type Episode,
  type ManageApplyBody,
  type ManageEpisodeRef,
  type ManageFileRow,
  type ManageFileUpdate,
  type QualityRegistryItem,
  type ScanPreview,
} from "../../api/types";
import { Badge, EmptyState, ErrorState, Spinner, formatBytes } from "../../lib/ui";
import { distributeEpisodes, qualityRegistryTitle } from "../../lib/manageFiles";

// The full language picker list (mirrors upstream's useFilteredLanguages with Any/Original
// pseudo-entries; the two pseudo-entries are never stored on a file, they're picker conveniences).
const MANAGE_LANGUAGES: readonly string[] = [
  "Any", "Unknown", "Arabic", "Bosnian", "Bulgarian", "Catalan", "Chinese", "Croatian", "Czech",
  "Danish", "Dutch", "English", "Estonian", "Finnish", "Flemish", "French", "German", "Greek",
  "Hebrew", "Hindi", "Hungarian", "Icelandic", "Indonesian", "Italian", "Japanese", "Korean",
  "Latvian", "Lithuanian", "Norwegian", "Original", "Persian", "Polish", "Portuguese",
  "Portuguese (Brazil)", "Romanian", "Russian", "Serbian", "Slovak", "Slovenian", "Spanish",
  "Spanish (Latin America)", "Swedish", "Thai", "Turkish", "Ukrainian", "Vietnamese",
];

const RELEASE_TYPES: readonly { value: "single" | "multi" | "season" | null; label: string }[] = [
  { value: null, label: "Unknown" },
  { value: "single", label: "Single Episode" },
  { value: "multi", label: "Multi Episode" },
  { value: "season", label: "Season Pack" },
];

type PickerField = "season" | "episode" | "quality" | "releaseGroup" | "language" | "indexerFlags" | "releaseType";

/** A pending per-row edit, applied only when the user hits Import. `seasonNumber` is a pure
 *  display override for the season picker (a file's season is derived from its episodes on the
 *  backend, so the picker expresses "assigned to season N, episodes to follow" as episodes: []). */
interface PendingEdit {
  quality?: { source: string; resolution: string; edition: string; modifier?: string };
  languages?: string[];
  releaseGroup?: string | null;
  releaseType?: "single" | "multi" | "season" | null;
  indexerFlags?: number;
  episodes?: string[];
  seasonNumber?: number;
}

interface RowView extends ManageFileRow {
  key: string;
  qualityTitle: string;
}

interface EpisodeView {
  episode: Episode;
  seasonNumber: number;
}

function registryQualityKey(q: { source: string; resolution: string; modifier?: string }): string {
  return `${q.source}:${q.resolution}:${q.modifier ?? "none"}`;
}

export function ManageFilesModal({
  mediaType,
  mediaId,
  seasonNumber,
  onClose,
}: {
  mediaType: "movie" | "series";
  mediaId: string;
  /** Series season scoping — omit for whole-series or movies. */
  seasonNumber?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const base = `${mediaType === "movie" ? "movies" : "series"}/${mediaId}`;
  const seasonQuery = mediaType === "series" && seasonNumber !== undefined ? `?season=${seasonNumber}` : "";
  const scopeLabel = mediaType === "movie" ? "Files" : seasonNumber !== undefined ? `Episodes · Season ${seasonNumber}` : "Episodes";

  const preview = useQuery({
    queryKey: ["manage-files", mediaType, mediaId, seasonNumber],
    queryFn: () => api.get<ScanPreview>(`/${base}/manage-files${seasonQuery}`),
  });
  const registry = useQuery({
    queryKey: ["quality-registry"],
    queryFn: () => api.get<QualityRegistryItem[]>("/quality-profiles/registry"),
  });
  const registryRows = registry.data ?? [];

  // The series' full season list for the Season picker (all seasons, not just ones with files).
  const seasonsQuery = useQuery({
    queryKey: ["series-seasons", mediaId],
    queryFn: () => api.get<{ id: string; seasonNumber: number; monitored: boolean }[]>(`/series/${mediaId}/seasons`),
    enabled: mediaType === "series",
  });

  // Series episode surface for the Episode(s) picker.
  const episodesQuery = useQuery({
    queryKey: ["series-episodes", mediaId],
    queryFn: () => api.get<EpisodeView[]>(`/series/${mediaId}/episodes`),
    enabled: mediaType === "series",
  });
  const episodeById = useMemo(() => {
    const m = new Map<string, ManageEpisodeRef>();
    for (const ev of episodesQuery.data ?? []) {
      m.set(ev.episode.id, {
        id: ev.episode.id,
        seasonNumber: ev.seasonNumber,
        episodeNumber: ev.episode.episodeNumber,
        title: ev.episode.title,
        airDateUtc: ev.episode.airDateUtc,
      });
    }
    return m;
  }, [episodesQuery.data]);

  const [edits, setEdits] = useState<Record<string, PendingEdit>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [picker, setPicker] = useState<{ field: PickerField; rowKeys: string[] } | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; isErr?: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = useMemo(() => preview.data?.items ?? [], [preview.data]);

  // Reset local state when the underlying scan changes (fresh preview -> fresh session).
  useEffect(() => {
    setEdits({});
    setSelected({});
    setPicker(null);
  }, [preview.data]);

  const rows: RowView[] = useMemo(() => {
    return items.map((r) => {
      const key = r.mediaFileId ?? `u:${r.relativePath}`;
      const edit = edits[key];
      const episodes = edit?.episodes !== undefined
        ? edit.episodes.map((id) => episodeById.get(id)).filter((e): e is ManageEpisodeRef => e !== undefined)
        : r.episodes ?? [];
      const quality = edit?.quality ?? r.quality;
      return {
        ...r,
        key,
        episodes: episodes.length > 0 ? episodes : undefined,
        seasonNumber: edit?.seasonNumber ?? (episodes[0]?.seasonNumber ?? r.seasonNumber),
        quality,
        qualityTitle: qualityRegistryTitle(quality, registryRows),
        languages: edit?.languages ?? r.languages,
        releaseGroup: edit?.releaseGroup !== undefined ? edit.releaseGroup : r.releaseGroup,
        releaseType: edit?.releaseType !== undefined ? edit.releaseType : r.releaseType,
        indexerFlags: edit?.indexerFlags ?? r.indexerFlags,
      };
    });
  }, [items, edits, episodeById, registryRows]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => a.relativePath.localeCompare(b.relativePath) * dir);
  }, [rows, sortDir]);

  const showIndexerFlags = rows.some((r) => r.indexerFlags !== 0);

  const flash = (msg: string, isErr = false) => {
    setToast({ msg, isErr });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  const setRowEditBulk = (rowKeys: string[], patch: PendingEdit) => {
    setEdits((s) => {
      const next = { ...s };
      for (const key of rowKeys) next[key] = { ...(next[key] ?? {}), ...patch };
      return next;
    });
    setSelected((s) => {
      const next = { ...s };
      for (const key of rowKeys) next[key] = true;
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const next: Record<string, boolean> = {};
      for (const r of rows) next[r.key] = true;
      setSelected(next);
    } else {
      setSelected({});
    }
  };

  const selectedCount = rows.filter((r) => selected[r.key]).length;
  const anySelected = selectedCount > 0;
  const isImportable = (r: RowView) => mediaType === "movie" || (r.episodes?.length ?? 0) > 0;
  const hasImportableSelection = rows.some(
    (r) => selected[r.key] && (isImportable(r) || (r.mediaFileId && !r.stale && edits[r.key])),
  );

  // Bulk "Select…" bar — Episode(s) is season-locked upstream (all checked rows share one season).
  // Returns null when the lock can't be satisfied.
  const bulkSeasonLocked = (): number | null => {
    const sel = rows.filter((r) => selected[r.key]);
    if (sel.length === 0) return null;
    const seasons = new Set(sel.map((r) => r.seasonNumber).filter((n): n is number => n !== undefined));
    if (seasons.size > 1) return null;
    return [...seasons][0] ?? null;
  };

  const selectedKeys = rows.filter((r) => selected[r.key]).map((r) => r.key);

  const openPicker = (field: PickerField, rowKeys: string[]) => {
    setSelectOpen(false);
    if (field === "episode" && rowKeys.length > 1) {
      const lock = bulkSeasonLocked();
      if (lock === null) {
        flash("Selected files must be in the same season", true);
        return;
      }
    }
    setPicker({ field, rowKeys });
  };

  const apply = useMutation({
    mutationFn: (body: ManageApplyBody) => api.post(`/${base}/manage-files/apply${seasonQuery}`, body),
    onSuccess: () => {
      if (mediaType === "movie") {
        qc.invalidateQueries({ queryKey: ["files", "movie", mediaId] });
        qc.invalidateQueries({ queryKey: ["movie", mediaId] });
      } else {
        qc.invalidateQueries({ queryKey: ["files", "series", mediaId] });
        qc.invalidateQueries({ queryKey: ["series", mediaId] });
        qc.invalidateQueries({ queryKey: ["series-episodes", mediaId] });
      }
      qc.invalidateQueries({ queryKey: ["manage-files", mediaType, mediaId, seasonNumber] });
      onClose();
    },
  });

  const toUpdates = (): ManageFileUpdate[] =>
    rows
      .filter((r) => selected[r.key] && r.mediaFileId && !r.stale && edits[r.key])
      .map((r) => {
        const e = edits[r.key]!;
        const up: ManageFileUpdate = { mediaFileId: r.mediaFileId! };
        if (e.quality !== undefined) up.quality = e.quality;
        if (e.languages !== undefined) up.languages = e.languages;
        if (e.releaseGroup !== undefined) up.releaseGroup = e.releaseGroup;
        if (e.releaseType !== undefined) up.releaseType = e.releaseType;
        if (e.indexerFlags !== undefined) up.indexerFlags = e.indexerFlags;
        if (e.episodes !== undefined) up.episodes = e.episodes;
        return up;
      });

  const onImport = () => {
    const body: ManageApplyBody = { removeStale: [], importUntracked: [], deleteFiles: [], deleteUntracked: [], updates: [] };
    for (const r of rows) {
      if (!selected[r.key]) continue;
      if (!r.mediaFileId && isImportable(r)) body.importUntracked.push(r.relativePath);
    }
    body.updates = toUpdates();
    if (body.importUntracked.length === 0 && body.updates.length === 0) {
      flash(mediaType === "series" ? "No checked episodes are importable — assign episodes first" : "Nothing to import", true);
      return;
    }
    apply.mutate(body);
  };

  const onDelete = () => {
    const body: ManageApplyBody = { removeStale: [], importUntracked: [], deleteFiles: [], deleteUntracked: [], updates: [] };
    for (const r of rows) {
      if (!selected[r.key]) continue;
      if (r.mediaFileId) {
        if (r.stale) body.removeStale.push(r.mediaFileId);
        else body.deleteFiles.push(r.mediaFileId);
      } else {
        body.deleteUntracked.push(r.relativePath);
      }
    }
    if (body.removeStale.length === 0 && body.deleteFiles.length === 0 && body.deleteUntracked.length === 0) {
      flash("Nothing selected to delete", true);
      return;
    }
    apply.mutate(body);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-14" onClick={onClose}>
      <div
        className="w-full max-w-[1180px] overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-3">
          <h3 className="font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink">
            {mediaType === "movie" ? "Manage Files" : "Manage Episodes"}
            {preview.data && <span className="ml-2 normal-case tracking-normal text-ink-dim">· {scopeLabel}</span>}
          </h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[66vh] overflow-auto">
          {preview.isLoading ? (
            <Spinner label="Scanning folder…" />
          ) : preview.isError ? (
            <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="All files on disk are already tracked."
              hint="Nothing new to import and nothing missing — this folder matches the database."
            />
          ) : (
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="bg-bg text-left text-[10px] font-semibold uppercase tracking-[0.03em] text-ink-dim">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-accent"
                      checked={selectedCount === rows.length && rows.length > 0}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                  </th>
                  <th
                    className="cursor-pointer select-none px-2 py-2 hover:text-ink"
                    onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                    title="Sort by path"
                  >
                    Relative Path {sortDir === "asc" ? "↑" : "↓"}
                  </th>
                  {mediaType === "series" && <th className="px-2 py-2">Season</th>}
                  {mediaType === "series" && <th className="px-2 py-2">Episode(s)</th>}
                  <th className="px-2 py-2">Release Group</th>
                  <th className="px-2 py-2">Quality</th>
                  <th className="px-2 py-2">Languages</th>
                  <th className="px-2 py-2">Size</th>
                  {mediaType === "series" && <th className="px-2 py-2">Release Type</th>}
                  <th className="px-2 py-2 text-center" title="Custom Formats">
                    <Star className="mx-auto h-3.5 w-3.5" />
                  </th>
                  {showIndexerFlags && (
                    <th className="px-2 py-2 text-center" title="Indexer Flags">
                      <Flag className="mx-auto h-3.5 w-3.5" />
                    </th>
                  )}
                  <th className="w-8 px-2 py-2 text-center" title="Rejections">
                    <AlertTriangle className="mx-auto h-3.5 w-3.5" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {sorted.map((r) => (
                  <Row
                    key={r.key}
                    row={r}
                    mediaType={mediaType}
                    selected={!!selected[r.key]}
                    onToggle={(c) => setSelected((s) => ({ ...s, [r.key]: c }))}
                    showIndexerFlags={showIndexerFlags}
                    onEdit={(field) => setPicker({ field, rowKeys: [r.key] })}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-rule px-4 py-3">
          <button
            onClick={onDelete}
            disabled={apply.isPending || !anySelected}
            className="inline-flex items-center gap-1.5 rounded-lg border border-err/40 bg-err-bg px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-err-ink hover:bg-err/20 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>

          <div className="relative">
            <button
              onClick={() => setSelectOpen((o) => !o)}
              className="inline-flex min-w-[9rem] items-center justify-between gap-2 rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink-dim hover:bg-rule"
            >
              Select… <ChevronDown className="h-4 w-4" />
            </button>
            {selectOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setSelectOpen(false)} />
                <div className="absolute bottom-full left-0 z-40 mb-2 w-52 overflow-hidden rounded-lg border border-rule bg-surface shadow-xl">
                  {mediaType === "series" && (
                    <BulkItem label="Select Season" disabled={!anySelected} onClick={() => openPicker("season", selectedKeys)} />
                  )}
                  <BulkItem
                    label="Select Episode(s)"
                    disabled={!anySelected || bulkSeasonLocked() === null}
                    onClick={() => openPicker("episode", selectedKeys)}
                  />
                  <BulkItem label="Select Quality" disabled={!anySelected} onClick={() => openPicker("quality", selectedKeys)} />
                  <BulkItem label="Select Release Group" disabled={!anySelected} onClick={() => openPicker("releaseGroup", selectedKeys)} />
                  <BulkItem label="Select Language" disabled={!anySelected} onClick={() => openPicker("language", selectedKeys)} />
                  <BulkItem label="Select Indexer Flags" disabled={!anySelected} onClick={() => openPicker("indexerFlags", selectedKeys)} />
                  {mediaType === "series" && (
                    <BulkItem label="Select Release Type" disabled={!anySelected} onClick={() => openPicker("releaseType", selectedKeys)} />
                  )}
                </div>
              </>
            )}
          </div>

          <span className="ml-auto self-center text-xs text-ink-dim tabular-nums">{selectedCount} selected</span>
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">
            Cancel
          </button>
          <button
            onClick={onImport}
            disabled={apply.isPending || !hasImportableSelection}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> {apply.isPending ? "Applying…" : "Import"}
          </button>
        </div>

        {toast && (
          <div
            className={`pointer-events-none fixed bottom-8 left-1/2 z-[70] -translate-x-1/2 rounded-lg px-4 py-2 text-xs shadow-xl ${toast.isErr ? "bg-err text-white" : "bg-ink text-bg"}`}
          >
            {toast.msg}
          </div>
        )}

        {picker && (
          <PickerModal
            field={picker.field}
            mediaType={mediaType}
            rowKeys={picker.rowKeys}
            rows={rows}
            registryRows={registryRows}
            episodeById={episodeById}
            seasonOptions={(seasonsQuery.data ?? []).map((s) => s.seasonNumber).sort((a, b) => b - a)}
            seasonNumberOverride={bulkSeasonLocked() ?? undefined}
            onApply={setRowEditBulk}
            onClose={() => setPicker(null)}
            flash={flash}
          />
        )}
      </div>
    </div>
  );
}

function BulkItem({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-bg disabled:cursor-not-allowed disabled:text-ink-dim disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function Row({
  row,
  mediaType,
  selected,
  onToggle,
  showIndexerFlags,
  onEdit,
}: {
  row: RowView;
  mediaType: "movie" | "series";
  selected: boolean;
  onToggle: (checked: boolean) => void;
  showIndexerFlags: boolean;
  onEdit: (field: PickerField) => void;
}) {
  // Frontend-only validity rejection (mirrors upstream): a series row needs episodes selected.
  const rejections = useMemo(() => {
    const out = [...row.rejections];
    if (mediaType === "series" && !row.stale && (row.episodes?.length ?? 0) === 0) {
      out.unshift({ reason: "no_episodes", message: "Episode not selected" });
    }
    return out;
  }, [row, mediaType]);

  const hint = (optional = false) => (
    <span
      className={`inline-block min-w-[54px] rounded-sm border border-dashed px-1 text-[11px] leading-none ${
        optional ? "border-ink-dim/60 bg-transparent" : "border-err bg-err-bg"
      } ${selected ? "opacity-100" : "opacity-40"}`}
    >
      &nbsp;
    </span>
  );

  const editCell = (field: PickerField, title: string, children: React.ReactNode) => (
    <button
      onClick={() => onEdit(field)}
      title={title}
      className="group/ec -m-1.5 inline-flex items-center gap-1 rounded-md p-1.5 hover:bg-accent/10 hover:text-accent"
    >
      {children}
    </button>
  );

  return (
    <tr className="hover:bg-bg">
      <td className="px-2 py-2">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={selected} onChange={(e) => onToggle(e.target.checked)} />
      </td>
      <td className="max-w-[220px] truncate px-2 py-2 font-mono text-[11.5px]" title={row.relativePath}>
        {row.relativePath}
      </td>
      {mediaType === "series" && (
        <td className="px-2 py-2">
          {editCell(
            "season",
            "Click to change season",
            row.seasonNumber !== undefined ? <span className="tabular-nums">{row.seasonNumber}</span> : hint(true),
          )}
        </td>
      )}
      {mediaType === "series" && (
        <td className="px-2 py-2">
          {editCell(
            "episode",
            "Click to change episode",
            row.episodes && row.episodes.length > 0 ? (
              <span className="inline-flex flex-col gap-0.5">
                {row.episodes.map((e) => (
                  <span key={e.id} className="whitespace-nowrap">
                    {e.episodeNumber} - {e.title}
                  </span>
                ))}
              </span>
            ) : (
              hint()
            ),
          )}
        </td>
      )}
      <td className="px-2 py-2">
        {editCell(
          "releaseGroup",
          "Click to change release group",
          row.releaseGroup ? <span className="whitespace-nowrap">{row.releaseGroup}</span> : hint(true),
        )}
      </td>
      <td className="px-2 py-2">
        {editCell("quality", "Click to change quality", row.quality ? <Badge tone="neutral">{row.qualityTitle}</Badge> : hint())}
      </td>
      <td className="px-2 py-2">
        {editCell(
          "language",
          "Click to change language",
          row.languages.length > 0 ? (
            <span className="inline-flex flex-wrap gap-1">
              {row.languages.map((l) => (
                <Badge key={l} tone="neutral">
                  {l}
                </Badge>
              ))}
            </span>
          ) : (
            hint(true)
          ),
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-ink-dim tabular-nums">{formatBytes(row.size)}</td>
      {mediaType === "series" && (
        <td className="px-2 py-2">
          {editCell(
            "releaseType",
            "Click to change release type",
            row.releaseType ? <span>{RELEASE_TYPES.find((t) => t.value === row.releaseType)?.label ?? row.releaseType}</span> : hint(true),
          )}
        </td>
      )}
      <td className="px-2 py-2 text-center">
        {row.matchedFormats.length > 0 ? (
          <span className="group/cf relative inline-block cursor-pointer">
            <span className="font-semibold text-ink-dim">+{row.matchedFormats.length}</span>
            <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1.5 hidden w-52 flex-wrap gap-1 rounded-lg border border-rule bg-surface p-2 shadow-xl group-hover/cf:flex">
              {row.matchedFormats.map((f) => (
                <Badge key={f.id} tone="info">
                  {f.name}
                </Badge>
              ))}
            </span>
          </span>
        ) : (
          <span className="text-ink-dim">—</span>
        )}
      </td>
      {showIndexerFlags && (
        <td className="px-2 py-2 text-center">
          <button
            onClick={() => onEdit("indexerFlags")}
            title="Click to change indexer flags"
            className="group/ec -m-1.5 rounded-md p-1.5 hover:bg-accent/10 hover:text-accent"
          >
            {row.indexerFlags !== 0 ? (
              <span className="group/fl relative inline-flex items-center gap-1 text-ink-dim">
                <Flag className="h-3.5 w-3.5" /> {indexerFlagLabels(row.indexerFlags).length}
                <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1.5 hidden w-44 flex-wrap gap-1 rounded-lg border border-rule bg-surface p-2 shadow-xl group-hover/fl:flex">
                  {indexerFlagLabels(row.indexerFlags).map((l) => (
                    <Badge key={l} tone="info">
                      {l}
                    </Badge>
                  ))}
                </span>
              </span>
            ) : (
              <span
                className={`inline-block min-w-[54px] rounded-sm border border-dashed border-ink-dim/60 px-1 text-[11px] leading-none ${
                  selected ? "opacity-100" : "opacity-40"
                }`}
              >
                &nbsp;
              </span>
            )}
          </button>
        </td>
      )}
      <td className="px-2 py-2 text-center">
        {rejections.length > 0 ? (
          <span className="group/rej relative inline-flex">
            <span className="h-2 w-2 rounded-full bg-err" />
            <span className="pointer-events-none absolute bottom-full right-0 z-10 mb-1.5 hidden rounded-lg border border-err bg-surface p-2 shadow-xl group-hover/rej:block">
              <ul className="list-disc pl-4 text-[11.5px] text-err-ink">
                {rejections.map((rej, i) => (
                  <li key={i}>{rej.message}</li>
                ))}
              </ul>
            </span>
          </span>
        ) : (
          <span className="text-ink-dim">—</span>
        )}
      </td>
    </tr>
  );
}

/** The sub-picker modal: Season (click-to-apply), Episode(s) (checkbox table + distribution),
 *  Quality / Release Type (dropdowns), Release Group (text), Language / Indexer Flags (grid). */
function PickerModal({
  field,
  mediaType,
  rowKeys,
  rows,
  registryRows,
  episodeById,
  seasonOptions,
  seasonNumberOverride,
  onApply,
  onClose,
  flash,
}: {
  field: PickerField;
  mediaType: "movie" | "series";
  rowKeys: string[];
  rows: RowView[];
  registryRows: QualityRegistryItem[];
  episodeById: Map<string, ManageEpisodeRef>;
  /** The series' full season list (newest first) for the Season picker. */
  seasonOptions: number[];
  seasonNumberOverride?: number;
  onApply: (rowKeys: string[], patch: PendingEdit) => void;
  onClose: () => void;
  flash: (msg: string, isErr?: boolean) => void;
}) {
  const targetRows = rows.filter((r) => rowKeys.includes(r.key));
  const single = rowKeys.length === 1 ? targetRows[0] : undefined;

  const [qualityKey, setQualityKey] = useState(single?.quality ? registryQualityKey(single.quality) : "unknown:unknown:none");
  const [qualityProper, setQualityProper] = useState(!!(single?.quality?.edition ?? "").toLowerCase().includes("proper"));
  const [qualityReal, setQualityReal] = useState(!!(single?.quality?.edition ?? "").toLowerCase().includes("real"));
  const [releaseGroup, setReleaseGroup] = useState(single?.releaseGroup ?? "");
  const [releaseType, setReleaseType] = useState<string>(single?.releaseType ?? "");
  const [languages, setLanguages] = useState<string[]>(single?.languages ?? []);
  const [flagMask, setFlagMask] = useState<number>(single?.indexerFlags ?? 0);
  const [episodeSel, setEpisodeSel] = useState<Set<string>>(new Set((single?.episodes ?? []).map((e) => e.id)));
  const [epFilter, setEpFilter] = useState("");

  const seasonEpisodes = useMemo(() => {
    // Episode picker is always scoped to one season: a single row's season, or the bulk bar's
    // shared season (guaranteed single by the season lock). Rows without a season default to 0.
    const season = single?.seasonNumber ?? seasonNumberOverride ?? 0;
    return [...episodeById.values()].filter((e) => e.seasonNumber === season).sort((a, b) => a.episodeNumber - b.episodeNumber);
  }, [episodeById, single, seasonNumberOverride]);

  const matchesFilter = (e: ManageEpisodeRef, q: string) =>
    q === "" || e.title.toLowerCase().includes(q.toLowerCase()) || String(e.episodeNumber).includes(q);

  const titles: Record<PickerField, string> = {
    season: "Select Season",
    episode: "Select Episode(s)",
    quality: "Select Quality",
    releaseGroup: "Set Release Group",
    language: "Select Language",
    indexerFlags: "Set Indexer Flags",
    releaseType: "Select Release Type",
  };

  const scopeLabel = single ? single.relativePath.split("/").pop() : `${rowKeys.length} selected row(s)`;

  const confirm = () => {
    if (field === "episode") {
      const checked = seasonEpisodes.filter((e) => episodeSel.has(e.id));
      if (checked.length === 0) {
        flash("Select at least one episode", true);
        return;
      }
      const slices = distributeEpisodes(checked, rowKeys.length);
      if (slices.length === 0) {
        flash(`${checked.length} episode(s) does not divide evenly across ${rowKeys.length} selected file(s)`, true);
        return;
      }
      const keys = [...rowKeys];
      for (let i = 0; i < keys.length; i++) {
        onApply([keys[i]], { episodes: slices[i].map((e) => e.id) });
      }
      onClose();
      flash(`Set episode(s) on ${rowKeys.length} row(s)`);
      return;
    }
    if (field === "quality") {
      const q = registryRows.find((r) => r.key === qualityKey);
      if (!q) return;
      const edition = [qualityProper ? "Proper" : "", qualityReal ? "Real" : ""].filter(Boolean).join(" ");
      onApply(rowKeys, { quality: { source: q.source, resolution: q.resolution, modifier: q.modifier, edition } });
      onClose();
      flash(`Set quality to "${q.title}" on ${rowKeys.length} row(s)`);
      return;
    }
    if (field === "releaseGroup") {
      onApply(rowKeys, { releaseGroup: releaseGroup.trim() || null });
      onClose();
      flash(`Set release group on ${rowKeys.length} row(s)`);
      return;
    }
    if (field === "releaseType") {
      onApply(rowKeys, { releaseType: releaseType === "" ? null : (releaseType as "single" | "multi" | "season") });
      onClose();
      flash(`Set release type on ${rowKeys.length} row(s)`);
      return;
    }
    if (field === "language") {
      const picked = languages.filter((l) => l !== "Any" && l !== "Original");
      if (picked.length === 0) {
        flash("Select at least one language", true);
        return;
      }
      onApply(rowKeys, { languages: picked });
      onClose();
      flash(`Set language(s) on ${rowKeys.length} row(s)`);
      return;
    }
    if (field === "indexerFlags") {
      onApply(rowKeys, { indexerFlags: flagMask });
      onClose();
      flash(`Set indexer flags on ${rowKeys.length} row(s)`);
      return;
    }
  };

  const visibleEpisodes = seasonEpisodes.filter((e) => matchesFilter(e, epFilter));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55" onClick={onClose}>
      <div
        className={`flex max-h-[80vh] flex-col overflow-hidden rounded-xl border border-rule bg-surface shadow-2xl ${
          field === "episode" || field === "language" || field === "indexerFlags" ? "w-[540px]" : "w-80"
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
          <h4 className="font-display text-xs font-bold uppercase tracking-[0.04em] text-ink">
            {mediaType === "movie" ? "Manage Files" : "Manage Episodes"} - {titles[field]}
          </h4>
          <button onClick={onClose} className="rounded-md p-1 text-ink-dim hover:bg-bg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {field === "season" && (
            <div className="space-y-1">
              {Array.from(new Set([single?.seasonNumber ?? seasonNumberOverride ?? 0, ...seasonOptions])).map((num) => (
                <button
                  key={num}
                  onClick={() => {
                    onApply(rowKeys, { seasonNumber: num, episodes: [] });
                    onClose();
                    flash(`Set season to ${num === 0 ? "Specials" : `Season ${num}`} on ${rowKeys.length} row(s)`);
                  }}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent/10 hover:text-accent ${
                    num === (single?.seasonNumber ?? seasonNumberOverride ?? 0) ? "font-bold text-accent" : "text-ink"
                  }`}
                >
                  {num === 0 ? "Specials" : `Season ${num}`}
                </button>
              ))}
            </div>
          )}

          {field === "episode" && (
            <>
              <input
                value={epFilter}
                onChange={(e) => setEpFilter(e.target.value)}
                placeholder="Filter episodes by title or number"
                className="w-full border-b border-rule bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:bg-bg"
              />
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="text-left text-[10px] font-semibold uppercase tracking-[0.03em] text-ink-dim">
                      <th className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-accent"
                          checked={visibleEpisodes.length > 0 && visibleEpisodes.every((e) => episodeSel.has(e.id))}
                          onChange={(e) => {
                            const next = new Set(episodeSel);
                            for (const ep of visibleEpisodes) {
                              if (e.target.checked) next.add(ep.id);
                              else next.delete(ep.id);
                            }
                            setEpisodeSel(next);
                          }}
                        />
                      </th>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2">Air Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEpisodes.map((e) => (
                      <tr
                        key={e.id}
                        className="cursor-pointer hover:bg-bg"
                        onClick={() => {
                          const next = new Set(episodeSel);
                          if (next.has(e.id)) next.delete(e.id);
                          else next.add(e.id);
                          setEpisodeSel(next);
                        }}
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-accent"
                            checked={episodeSel.has(e.id)}
                            onChange={(ev) => ev.stopPropagation()}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              const next = new Set(episodeSel);
                              if (next.has(e.id)) next.delete(e.id);
                              else next.add(e.id);
                              setEpisodeSel(next);
                            }}
                          />
                        </td>
                        <td className="px-3 py-2 text-ink-dim tabular-nums">{e.episodeNumber}</td>
                        <td className="px-3 py-2">{e.title}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-ink-dim tabular-nums">
                          {e.airDateUtc ? e.airDateUtc.slice(0, 10) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {field === "quality" && (
            <div>
              <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.04em] text-ink-dim">Quality</label>
              <select
                value={qualityKey}
                onChange={(e) => setQualityKey(e.target.value)}
                className="w-full rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                {registryRows.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.title}
                  </option>
                ))}
              </select>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-accent"
                  checked={qualityProper}
                  onChange={(e) => setQualityProper(e.target.checked)}
                />
                Proper
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-accent"
                  checked={qualityReal}
                  onChange={(e) => setQualityReal(e.target.checked)}
                />
                Real
              </label>
            </div>
          )}

          {field === "releaseGroup" && (
            <div>
              <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.04em] text-ink-dim">Release Group</label>
              <input
                value={releaseGroup}
                onChange={(e) => setReleaseGroup(e.target.value)}
                placeholder="e.g. FraMeSToR"
                className="w-full rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              />
            </div>
          )}

          {field === "releaseType" && (
            <div>
              <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-[0.04em] text-ink-dim">Release Type</label>
              <select
                value={releaseType}
                onChange={(e) => setReleaseType(e.target.value)}
                className="w-full rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
              >
                {RELEASE_TYPES.map((t) => (
                  <option key={t.label} value={t.value ?? ""}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {field === "language" && (
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {MANAGE_LANGUAGES.map((l) => (
                <label key={l} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-bg">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={languages.includes(l)}
                    onChange={(e) =>
                      setLanguages((s) => (e.target.checked ? [...s, l] : s.filter((x) => x !== l)))
                    }
                  />
                  {l}
                </label>
              ))}
            </div>
          )}

          {field === "indexerFlags" && (
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">
              {INDEXER_FLAGS.map((f) => (
                <label key={f.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-bg">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={(flagMask & f.bit) === f.bit}
                    onChange={(e) => setFlagMask((m) => (e.target.checked ? m | f.bit : m & ~f.bit))}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-rule px-4 py-2.5">
          <span className="text-[11px] text-ink-dim">{scopeLabel}</span>
          <span className="flex-1" />
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">
            Cancel
          </button>
          {field !== "season" && (
            <button
              onClick={confirm}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"
            >
              {field === "episode" ? "Select Episode(s)" : field === "releaseGroup" ? "Set Release Group" : field === "indexerFlags" ? "Set Indexer Flags" : "Select"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}