// SPDX-License-Identifier: MIT
// Calendar display options (CALENDAR-1), persisted the same way the theme/library-view
// preferences are — Zustand `persist` middleware into localStorage (see useAppStore.ts for the
// exact same pattern; this app has exactly one such mechanism, not a second one).
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CalendarView = "month" | "week" | "forecast" | "day" | "agenda";
export type FirstDayOfWeek = 0 | 1; // 0 = Sunday (default), 1 = Monday

interface CalendarOptions {
  /** Default view on load — Sonarr's own default is Week. */
  view: CalendarView;
  collapseMultipleEpisodes: boolean;
  showEpisodeInfo: boolean;
  fullColorEvents: boolean;
  firstDayOfWeek: FirstDayOfWeek;
  colorImpairedMode: boolean;
  setView: (v: CalendarView) => void;
  setCollapseMultipleEpisodes: (v: boolean) => void;
  setShowEpisodeInfo: (v: boolean) => void;
  setFullColorEvents: (v: boolean) => void;
  setFirstDayOfWeek: (v: FirstDayOfWeek) => void;
  setColorImpairedMode: (v: boolean) => void;
}

export const useCalendarStore = create<CalendarOptions>()(
  persist(
    (set) => ({
      view: "week",
      collapseMultipleEpisodes: false,
      showEpisodeInfo: true,
      fullColorEvents: false,
      firstDayOfWeek: 0,
      colorImpairedMode: false,
      setView: (view) => set({ view }),
      setCollapseMultipleEpisodes: (collapseMultipleEpisodes) => set({ collapseMultipleEpisodes }),
      setShowEpisodeInfo: (showEpisodeInfo) => set({ showEpisodeInfo }),
      setFullColorEvents: (fullColorEvents) => set({ fullColorEvents }),
      setFirstDayOfWeek: (firstDayOfWeek) => set({ firstDayOfWeek }),
      setColorImpairedMode: (colorImpairedMode) => set({ colorImpairedMode }),
    }),
    { name: "medianexus-calendar" },
  ),
);
