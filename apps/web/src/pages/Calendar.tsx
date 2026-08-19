// SPDX-License-Identifier: MIT
// Calendar (CALENDAR-1, Tier 1 item 7) — full Sonarr-parity calendar rebuilt from the old single
// flat 30-day list into five views: Month / Week / Forecast / Day / Agenda. Everything reuses
// what already exists: GET /calendar?start&end for arbitrary windows, CompletenessLegend for the
// legend, calendarEventCompleteness for per-event status, EpisodeDetailModal for click-through,
// and the existing command/auth endpoints for the toolbar. The one genuinely subtle part is the
// date math (Week is boundary-snapped, Forecast is a rolling window), which is implemented
// separately below rather than aliased.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Filter, ChevronLeft, ChevronRight, Settings2, Link2, Rss, Search } from "lucide-react";
import { clsx } from "clsx";
import { api } from "../api/client";
import type { CalendarEntry, Episode, MediaFileRow, QualityProfile, Series } from "../api/types";
import { Badge, ErrorState } from "../lib/ui";
import { CompletenessLegend, calendarEventCompleteness, completenessLetter } from "../components/Completeness";
import { EpisodeDetailModal } from "../components/detail/EpisodeDetailModal";
import { InteractiveSearchModal, type SearchScope } from "../components/detail/InteractiveSearchModal";
import { Modal } from "../components/Modal";
import { useCalendarStore, type CalendarView, type FirstDayOfWeek } from "../store/useCalendarStore";

// ---------- date helpers ----------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Inclusive end-of-day instant (23:59:59.999) for a query window's `end` — the /calendar endpoint
// matches `lte(end)`, so a day-boundary start won't include events later that same day (REVIEW
// CALENDAR-1: Day view with start===end showed nothing; events on the last day of Week/Forecast
// were silently dropped). Applied only where the API query's end is built — grid/dimming math
// keeps comparing day-boundaries, which is correct.
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfWeek(d: Date, firstDay: FirstDayOfWeek): Date {
  const day = startOfDay(d);
  const diff = (day.getDay() - firstDay + 7) % 7;
  return addDays(day, -diff);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function formatFull(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function eventDate(e: CalendarEntry): string {
  return e.mediaType === "episode" ? e.airDateUtc : e.releaseDate;
}

function isEpisode(e: CalendarEntry): e is Extract<CalendarEntry, { mediaType: "episode" }> {
  return e.mediaType === "episode";
}

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "forecast", label: "Forecast" },
  { key: "day", label: "Day" },
  { key: "agenda", label: "Agenda" },
];

const COMPL_LINE: Record<"complete" | "missing" | "upcoming", string> = {
  complete: "border-l-ok",
  missing: "border-l-warn",
  upcoming: "border-l-upcoming",
};
const COMPL_BG: Record<"complete" | "missing" | "upcoming", string> = {
  complete: "bg-ok/15",
  missing: "bg-warn/15",
  upcoming: "bg-upcoming/15",
};

export default function Calendar() {
  const nav = useNavigate();
  const store = useCalendarStore();
  const { view, firstDayOfWeek, collapseMultipleEpisodes, showEpisodeInfo, fullColorEvents, colorImpairedMode } = store;

  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [filter, setFilter] = useState<"all" | "monitored">("all");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [openEpisode, setOpenEpisode] = useState<Extract<CalendarEntry, { mediaType: "episode" }> | null>(null);
  const [searching, setSearching] = useState<SearchScope | null>(null);
  const [toolMsg, setToolMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // ---- per-view window and header (the Week vs Forecast distinction lives here) ----
  const { start, end, title } = useMemo(() => {
    const a = startOfDay(anchor);
    const fd = firstDayOfWeek;
    switch (view) {
      case "month": {
        const first = new Date(a.getFullYear(), a.getMonth(), 1);
        const prev = startOfWeek(first, fd); // grid starts on the boundary before the 1st
        const weeks = Math.ceil((startOfWeek(addDays(new Date(a.getFullYear(), a.getMonth() + 1, 0), 1), fd).getTime() - prev.getTime()) / (7 * 86400000));
        const s = prev;
        const e = addDays(prev, weeks * 7 - 1); // inclusive end = last grid cell
        return { start: s, end: e, title: `${MONTHS[a.getMonth()]} ${a.getFullYear()}` };
      }
      case "week": {
        const s = startOfWeek(a, fd);
        return { start: s, end: addDays(s, 6), title: `Week of ${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` };
      }
      case "forecast": {
        // Rolling, boundary-unsnapped window relative to the anchor: anchor-1 .. anchor+5 (7 days).
        const s = addDays(a, -1);
        return { start: s, end: addDays(a, 5), title: "Forecast (next 7 days)" };
      }
      case "day": {
        return { start: a, end: a, title: formatFull(a) };
      }
      case "agenda": {
        // Agenda keeps the original flat window (today-1 .. today+30) — the one view not getting
        // new navigation semantics; it always tracks the real "today", not the anchor.
        const t = startOfDay(new Date());
        return { start: addDays(t, -1), end: addDays(t, 30), title: "Next 30 days" };
      }
    }
  }, [view, anchor, firstDayOfWeek]);

  const entries = useQuery({
    queryKey: ["calendar", view, start.toISOString(), end.toISOString()],
    // The endpoint matches `gte(start)` / `lte(end)`, so the query's end must be the END OF the
    // last day, not its midnight (REVIEW CALENDAR-1) — otherwise an event airing later that day
    // is silently excluded (worst case Day view, where start===end meant nothing could ever show).
    queryFn: () => api.get<CalendarEntry[]>(`/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(endOfDay(end).toISOString())}`),
  });

  const items = useMemo(() => {
    const list = entries.data ?? [];
    return filter === "monitored" ? list.filter((e) => e.monitored) : list;
  }, [entries.data, filter]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of items) {
      const k = startOfDay(new Date(eventDate(e))).getTime();
      const l = map.get(String(k)) ?? [];
      l.push(e);
      map.set(String(k), l);
    }
    return map;
  }, [items]);

  // ---- navigation moves the anchor only (window recomputes from it) ----
  const nudge = (dir: 1 | -1) => {
    const a = startOfDay(anchor);
    const next =
      view === "day" ? addDays(a, dir)
      : view === "week" || view === "forecast" ? addDays(a, dir * 7)
      : view === "month" ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
      : a; // agenda: no-op (fixed today window)
    setAnchor(next);
  };
  const flash = (text: string, tone: "ok" | "err" = "ok") => {
    setToolMsg({ tone, text });
    setTimeout(() => setToolMsg(null), 2500);
  };

  const icalLink = useMutation({
    mutationFn: async () => {
      const { rawKey } = await api.get<{ rawKey: string | null }>("/auth/key");
      if (!rawKey) throw new Error("No API key available");
      const url = `${window.location.origin}/api/v1/calendar/ical?apikey=${encodeURIComponent(rawKey)}`;
      await navigator.clipboard.writeText(url);
      return url;
    },
    onSuccess: () => flash("iCal link copied to clipboard"),
    onError: (e) => flash(e instanceof Error ? e.message : "Failed to copy iCal link", "err"),
  });

  const rssSync = useMutation({
    mutationFn: () => api.post("/system/commands/media.rssSync"),
    onSuccess: () => flash("RSS sync started"),
    onError: (e) => flash(e instanceof Error ? e.message : "RSS sync failed", "err"),
  });

  const searchMissing = useMutation({
    mutationFn: () => api.post("/system/commands/media.missingSearch"),
    onSuccess: () => flash("Search for missing started"),
    onError: (e) => flash(e instanceof Error ? e.message : "Search failed", "err"),
  });

  const autoSearchEpisode = useMutation({
    mutationFn: ({ epId }: { epId: string }) => api.post(`/series/${openEpisode?.seriesId}/episodes/${epId}/auto-search`),
    onSuccess: () => flash("Quick search complete"),
    onError: (e) => flash(e instanceof Error ? e.message : "Quick search failed", "err"),
  });

  // ---- click-through ----
  const onEventClick = (e: CalendarEntry) => {
    if (e.mediaType === "episode") setOpenEpisode(e);
    else nav(`/movies/${e.movieId}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Calendar</h2>
          <p className="text-sm text-ink-dim">{title}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button onClick={() => icalLink.mutate()} disabled={icalLink.isPending} className="inline-flex items-center gap-1.5 rounded bg-bg px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50" title="Copy the iCal feed URL">
            <Link2 className="h-3.5 w-3.5" /> iCal Link
          </button>
          <button onClick={() => rssSync.mutate()} disabled={rssSync.isPending} className="inline-flex items-center gap-1.5 rounded bg-bg px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50" title="Run RSS sync">
            <Rss className="h-3.5 w-3.5" /> RSS Sync
          </button>
          <button onClick={() => searchMissing.mutate()} disabled={searchMissing.isPending} className="inline-flex items-center gap-1.5 rounded bg-bg px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule disabled:opacity-50" title="Search for missing episodes/movies">
            <Search className="h-3.5 w-3.5" /> Search for Missing
          </button>
        </div>

        <div className="mx-1 flex items-center gap-1">
          <button onClick={() => nudge(-1)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Previous"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setAnchor(startOfDay(new Date()))} className="rounded px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink hover:bg-rule">Today</button>
          <button onClick={() => nudge(1)} className="rounded p-1 text-ink-dim hover:bg-rule hover:text-ink" title="Next"><ChevronRight className="h-4 w-4" /></button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {toolMsg && <span className={clsx("text-xs", toolMsg.tone === "ok" ? "text-ok" : "text-err")}>{toolMsg.text}</span>}

          <div className="relative">
            <Filter className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-dim" />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as "all" | "monitored")}
              className="rounded-md border border-rule bg-bg py-1.5 pl-8 pr-2 text-xs text-ink focus:outline-none"
            >
              <option value="all">All</option>
              <option value="monitored">Monitored Only</option>
            </select>
          </div>

          <button onClick={() => setOptionsOpen(true)} className="rounded p-1.5 text-ink-dim hover:bg-rule hover:text-ink" title="Calendar options"><Settings2 className="h-4 w-4" /></button>

          <div className="flex gap-1 rounded-lg border border-rule bg-bg p-1">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => store.setView(v.key)}
                className={clsx("rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wide transition-colors",
                  view === v.key ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-rule hover:text-ink")}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {entries.isError ? <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
        : view === "agenda" ? <AgendaView items={byDay} onEventClick={onEventClick} letters={colorImpairedMode} />
        : view === "month" ? <MonthView anchor={anchor} today={startOfDay(new Date())} weekStart={firstDayOfWeek} byDay={byDay} onEventClick={onEventClick} showInfo={showEpisodeInfo} collapse={collapseMultipleEpisodes} fullColor={fullColorEvents} letters={colorImpairedMode} />
        : <DayColumns start={view === "forecast" ? start : start} count={view === "day" ? 1 : 7} today={startOfDay(new Date())} byDay={byDay} onEventClick={onEventClick} showInfo={showEpisodeInfo} collapse={collapseMultipleEpisodes} fullColor={fullColorEvents} letters={colorImpairedMode} />}

      <CompletenessLegend letters={colorImpairedMode} />

      {optionsOpen && <OptionsModal onClose={() => setOptionsOpen(false)} />}

      {openEpisode && (
        <EpisodeModalHost
          entry={openEpisode}
          onClose={() => setOpenEpisode(null)}
          onQuickSearch={() => autoSearchEpisode.mutate({ epId: openEpisode.id })}
          onInteractiveSearch={() => {
            setSearching({
              label: `S${String(openEpisode.seasonNumber).padStart(2, "0")}E${String(openEpisode.episodeNumber).padStart(2, "0")} ${openEpisode.title}`,
              mediaType: "series", mediaId: openEpisode.seriesId, query: openEpisode.seriesTitle,
              seasons: [openEpisode.seasonNumber], episodes: [openEpisode.episodeNumber],
            });
          }}
          onFileChanged={() => entries.refetch()}
        />
      )}
      {searching && <InteractiveSearchModal scope={searching} onClose={() => setSearching(null)} />}
    </div>
  );
}

// ---------- shared event card ----------

function EventCard({ e, showInfo, fullColor, letters, onClick }: {
  e: CalendarEntry; showInfo: boolean; fullColor: boolean; letters: boolean; onClick: () => void;
}) {
  const comp = calendarEventCompleteness({ monitored: e.monitored, hasFile: e.hasFile, date: eventDate(e) });
  const letter = completenessLetter(comp);
  const line = comp ? COMPL_LINE[comp] : "border-l-rule";
  const bg = comp && fullColor ? COMPL_BG[comp] : "";
  const showEpInfo = showInfo && isEpisode(e);
  return (
    <button
      onClick={onClick}
      className={clsx("block w-full truncate rounded border-l-2 px-2 py-1 text-left text-[11px] leading-tight hover:bg-rule/60", line, bg)}
      title={isEpisode(e) ? `${e.seriesTitle} S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")} ${e.title}` : e.movieTitle}
    >
      <span className="flex items-center gap-1">
        {letters && letter && <span className="font-bold text-ink">{letter}</span>}
        <span className="truncate font-medium text-ink">{isEpisode(e) ? e.seriesTitle : e.movieTitle}</span>
      </span>
      {showEpInfo && (
        <span className="block truncate text-ink-dim">
          S{String(e.seasonNumber).padStart(2, "0")}E{String(e.episodeNumber).padStart(2, "0")}
          {e.title ? ` · ${e.title}` : ""}
        </span>
      )}
    </button>
  );
}

// ---------- Month ----------

function MonthView({ anchor, today, weekStart, byDay, onEventClick, showInfo, collapse, fullColor, letters }: {
  anchor: Date; today: Date; weekStart: FirstDayOfWeek; byDay: Map<string, CalendarEntry[]>;
  onEventClick: (e: CalendarEntry) => void; showInfo: boolean; collapse: boolean; fullColor: boolean; letters: boolean;
}) {
  const weeks = useMemo(() => {
    const a = startOfDay(anchor);
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const gridStart = startOfWeek(first, weekStart);
    const monthCellCount = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();
    // Grid runs from the week-start boundary before the 1st through the week-start boundary
    // before the day after the last day of the month — both aligned to weekStart, so the span
    // is always a whole number of weeks and covers the full month (lead/trail from neighbours).
    const gridEnd = startOfWeek(addDays(first, monthCellCount), weekStart);
    const totalCells = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000);
    const out: Date[][] = [];
    for (let w = 0; w < totalCells / 7; w++) {
      const row: Date[] = [];
      for (let d = 0; d < 7; d++) row.push(addDays(gridStart, w * 7 + d));
      out.push(row);
    }
    return { weeks: out, gridStart };
  }, [anchor, weekStart]);

  const month = anchor.getMonth();
  const monthStart = new Date(anchor.getFullYear(), month, 1).getTime();
  const monthEnd = new Date(anchor.getFullYear(), month + 1, 0).getTime();

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="grid grid-cols-7 border-b border-rule bg-bg text-[10px] font-semibold uppercase tracking-wide text-ink-dim">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="px-2 py-1.5">{WEEKDAYS[(i + weekStart) % 7]}</div>
        ))}
      </div>
      {weeks.weeks.map((row, wi) => (
        <div key={wi} className="grid grid-cols-7 divide-x divide-rule border-b border-rule last:border-b-0">
          {row.map((d) => {
            const t = d.getTime();
            const out = t < monthStart || t > monthEnd;
            const isToday = isSameDay(d, today);
            const events = byDay.get(String(t)) ?? [];
            return (
              <div key={t} className={clsx("min-h-[5.5rem] p-1", out ? "bg-bg/60" : "")}>
                <div className={clsx("mb-1 flex h-5 w-5 items-center justify-center rounded text-[11px] tabular-nums",
                  isToday ? "bg-accent font-bold text-accent-ink" : out ? "text-ink-dim/60" : "text-ink")}>
                  {d.getDate()}
                </div>
                <DayEvents events={events} showInfo={showInfo} collapse={collapse} fullColor={fullColor} letters={letters} onEventClick={onEventClick} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------- Week / Forecast / Day columns ----------

function DayColumns({ start, count, today, byDay, onEventClick, showInfo, collapse, fullColor, letters }: {
  start: Date; count: number; today: Date; byDay: Map<string, CalendarEntry[]>;
  onEventClick: (e: CalendarEntry) => void; showInfo: boolean; collapse: boolean; fullColor: boolean; letters: boolean;
}) {
  const days = useMemo(() => Array.from({ length: count }, (_, i) => addDays(startOfDay(start), i)), [start, count]);
  return (
    <div className={clsx("grid gap-1", count > 1 ? "grid-cols-7" : "grid-cols-1")}>
      {days.map((d) => {
        const isToday = isSameDay(d, today);
        const events = byDay.get(String(startOfDay(d).getTime())) ?? [];
        return (
          <div key={d.getTime()} className={clsx("min-h-[8rem] rounded-lg border p-1.5", isToday ? "border-accent/50 bg-accent/5" : "border-rule bg-surface")}>
            <div className={clsx("mb-1 text-[10px] font-semibold uppercase tracking-wide", isToday ? "text-accent" : "text-ink-dim")}>
              {WEEKDAYS[d.getDay()]} {d.getDate()}
            </div>
            <DayEvents events={events} showInfo={showInfo} collapse={collapse} fullColor={fullColor} letters={letters} onEventClick={onEventClick} />
          </div>
        );
      })}
    </div>
  );
}

// ---------- event list (optionally collapses same-series episodes) ----------

function DayEvents({ events, showInfo, collapse, fullColor, letters, onEventClick }: {
  events: CalendarEntry[]; showInfo: boolean; collapse: boolean; fullColor: boolean; letters: boolean;
  onEventClick: (e: CalendarEntry) => void;
}) {
  if (events.length === 0) return null;
  const collapseSameSeries = collapse && events.filter(isEpisode).length > 1;
  if (!collapseSameSeries) {
    return <div className="space-y-0.5">{events.map((e) => <EventCard key={isEpisode(e) ? e.id : "m" + e.movieId} e={e} showInfo={showInfo} fullColor={fullColor} letters={letters} onClick={() => onEventClick(e)} />)}</div>;
  }
  // Collapse episodes of the SAME series on the same day into one card; movies stay separate.
  const groups: CalendarEntry[][] = [];
  const bySeries = new Map<string, CalendarEntry[]>();
  for (const e of events) {
    if (isEpisode(e)) {
      const l = bySeries.get(e.seriesId) ?? [];
      l.push(e);
      bySeries.set(e.seriesId, l);
    }
  }
  const used = new Set<string>();
  for (const e of events) {
    if (!isEpisode(e) || used.has(e.seriesId)) continue;
    const eps = bySeries.get(e.seriesId)!;
    used.add(e.seriesId);
    if (eps.length > 1) groups.push(eps);
    else groups.push([e]);
  }
  for (const e of events) if (!isEpisode(e)) groups.push([e]);

  return <div className="space-y-0.5">{groups.map((g) => <CollapsedCard key={g.map((x) => isEpisode(x) ? x.id : x.movieId).join("-")} group={g} fullColor={fullColor} letters={letters} onEventClick={onEventClick} />)}</div>;
}

function CollapsedCard({ group, fullColor, letters, onEventClick }: {
  group: CalendarEntry[]; fullColor: boolean; letters: boolean; onEventClick: (e: CalendarEntry) => void;
}) {
  const first = group[0];
  const isGrpEp = isEpisode(first);
  const comp = calendarEventCompleteness({ monitored: first.monitored, hasFile: first.hasFile, date: eventDate(first) });
  const letter = completenessLetter(comp);
  const line = comp ? COMPL_LINE[comp] : "border-l-rule";
  const bg = comp && fullColor ? COMPL_BG[comp] : "";
  const label = isGrpEp
    ? `${first.seriesTitle} — ${group.length} episodes`
    : first.movieTitle;
  return (
    <button onClick={() => onEventClick(first)} className={clsx("block w-full truncate rounded border-l-2 px-2 py-1 text-left text-[11px] leading-tight hover:bg-rule/60", line, bg)} title={label}>
      <span className="flex items-center gap-1">
        {letters && letter && <span className="font-bold text-ink">{letter}</span>}
        <span className="truncate font-medium text-ink">{label}</span>
      </span>
    </button>
  );
}

// ---------- Agenda (kept as before, plus color coding + click-through) ----------

function AgendaView({ items, onEventClick, letters }: {
  items: Map<string, CalendarEntry[]>; onEventClick: (e: CalendarEntry) => void;
  letters: boolean;
}) {
  const rows = [...items.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (rows.length === 0) return <div className="rounded-lg border border-dashed border-rule bg-surface p-6 text-center text-sm text-ink-dim">Nothing scheduled.</div>;
  return (
    <div className="space-y-3">
      {rows.map(([k, list]) => {
        return (
          <section key={k} className="rounded-xl border border-rule bg-surface p-4">
            <h3 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">
              {new Date(Number(k)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </h3>
            <div className="divide-y divide-rule">
              {list.map((e) => {
                const comp = calendarEventCompleteness({ monitored: e.monitored, hasFile: e.hasFile, date: eventDate(e) });
                const letter = completenessLetter(comp);
                const line = comp ? COMPL_LINE[comp] : "border-l-rule";
                return (
                  <button key={isEpisode(e) ? e.id : "m" + e.movieId} onClick={() => onEventClick(e)}
                    className={clsx("flex w-full items-center gap-3 border-l-2 py-2 pl-3 text-left hover:bg-rule/40", line)}>
                    {letters && letter && <span className="text-xs font-bold text-ink">{letter}</span>}
                    <span className="truncate">
                      {isEpisode(e) ? (
                        <><span className="font-medium text-ink">{e.seriesTitle}</span>
                          <span className="text-ink-dim"> · S{String(e.seasonNumber).padStart(2, "0")}E{String(e.episodeNumber).padStart(2, "0")}</span>
                          {e.title ? <span className="text-ink-dim"> · {e.title}</span> : null}
                        </>
                      ) : (
                        <><span className="font-medium text-ink">{e.movieTitle}</span>
                          {e.releaseDate ? <span className="text-ink-dim"> · Movie</span> : null}
                        </>
                      )}
                    </span>
                    <span className="ml-auto"><Badge tone={comp ? (comp === "complete" ? "ok" : comp === "missing" ? "warn" : "upcoming") : "neutral"}>{comp ?? "Unmonitored"}{comp && letters ? ` · ${letter}` : ""}</Badge></span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------- Options modal (exactly the 6 fields; no dead controls) ----------

function OptionsModal({ onClose }: { onClose: () => void }) {
  const store = useCalendarStore();
  const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <p className="text-sm text-ink">{label}</p>
        {hint && <p className="text-xs text-ink-dim">{hint}</p>}
      </div>
      {children}
    </div>
  );
  return (
    <Modal title="Calendar Options" onClose={onClose}>
      <div className="divide-y divide-rule px-4 py-2">
        <Row label="Collapse Multiple Episodes" hint="Group same-series episodes airing the same day into one card.">
          <input type="checkbox" checked={store.collapseMultipleEpisodes} onChange={(e) => store.setCollapseMultipleEpisodes(e.target.checked)} />
        </Row>
        <Row label="Show Episode Information" hint="Show episode title and number on cards.">
          <input type="checkbox" checked={store.showEpisodeInfo} onChange={(e) => store.setShowEpisodeInfo(e.target.checked)} />
        </Row>
        <Row label="Full Color Events" hint="Fill the whole card with the status color instead of just the left border. (Agenda always uses the left-border style.)">
          <input type="checkbox" checked={store.fullColorEvents} onChange={(e) => store.setFullColorEvents(e.target.checked)} />
        </Row>
        <Row label="First Day of Week">
          <select value={store.firstDayOfWeek} onChange={(e) => store.setFirstDayOfWeek(Number(e.target.value) as FirstDayOfWeek)} className="rounded-md border border-rule bg-bg px-2 py-1 text-sm text-ink">
            <option value={0}>Sunday</option>
            <option value={1}>Monday</option>
          </select>
        </Row>
        <Row label="Enable Color-Impaired Mode" hint="Add a letter (C/M/U) to every event and the legend so status is never conveyed by color alone.">
          <input type="checkbox" checked={store.colorImpairedMode} onChange={(e) => store.setColorImpairedMode(e.target.checked)} />
        </Row>
      </div>
    </Modal>
  );
}

// ---------- on-demand episode modal host ----------

function EpisodeModalHost({ entry, onClose, onQuickSearch, onInteractiveSearch, onFileChanged }: {
  entry: Extract<CalendarEntry, { mediaType: "episode" }>;
  onClose: () => void; onQuickSearch: () => void; onInteractiveSearch: () => void; onFileChanged: () => void;
}) {
  const series = useQuery({ queryKey: ["series", entry.seriesId], queryFn: () => api.get<Series>(`/series/${entry.seriesId}`) });
  const eps = useQuery({ queryKey: ["series-episodes", entry.seriesId], queryFn: () => api.get<{ episode: Episode; seasonNumber: number }[]>(`/series/${entry.seriesId}/episodes`) });
  const files = useQuery({ queryKey: ["files", "series", entry.seriesId], queryFn: () => api.get<MediaFileRow[]>(`/series/${entry.seriesId}/files`) });
  const profiles = useQuery({ queryKey: ["quality-profiles"], queryFn: () => api.get<QualityProfile[]>("/quality-profiles") });

  const full = eps.data?.find((v) => v.episode.id === entry.id)?.episode ?? {
    id: entry.id, seriesId: entry.seriesId, seasonId: "", episodeNumber: entry.episodeNumber,
    absoluteNumber: null, title: entry.title, overview: "", airDateUtc: entry.airDateUtc,
    monitored: entry.monitored, hasFile: entry.hasFile, mediaFileId: null, episodeType: null,
  };
  const maxSeason = Math.max(0, ...(eps.data ?? []).map((v) => v.seasonNumber));
  const matchedFile = files.data?.find((f) => f.id === full.mediaFileId);
  const profileName = profiles.data?.find((p) => p.id === series.data?.qualityProfileId)?.name ?? "—";

  return (
    <EpisodeDetailModal
      seriesTitle={entry.seriesTitle}
      seasonNumber={entry.seasonNumber}
      episode={full}
      qualityProfileName={profileName}
      matchedFile={matchedFile}
      maxSeasonNumber={maxSeason}
      onClose={onClose}
      onQuickSearch={onQuickSearch}
      onInteractiveSearch={onInteractiveSearch}
      onFileChanged={onFileChanged}
    />
  );
}
