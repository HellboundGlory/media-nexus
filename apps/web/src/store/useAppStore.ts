// SPDX-License-Identifier: MIT
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  /** UNI-028 layout view for the Movies/Series library pages: poster grid (default) or table. */
  libraryView: "posters" | "table";
  setLibraryView: (view: "posters" | "table") => void;
  /** UNI-029 pass 1: client-side display options for the poster grid, persisted like theme. */
  posterSize: "small" | "medium" | "large";
  setPosterSize: (size: "small" | "medium" | "large") => void;
  showTitle: boolean;
  setShowTitle: (v: boolean) => void;
  showQualityProfile: boolean;
  setShowQualityProfile: (v: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      libraryView: "posters",
      setLibraryView: (libraryView) => set({ libraryView }),
      posterSize: "medium",
      setPosterSize: (posterSize) => set({ posterSize }),
      showTitle: true,
      setShowTitle: (showTitle) => set({ showTitle }),
      showQualityProfile: false,
      setShowQualityProfile: (showQualityProfile) => set({ showQualityProfile }),
    }),
    { name: "medianexus-ui" },
  ),
);

export function applyTheme(theme: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
