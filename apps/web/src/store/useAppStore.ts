// SPDX-License-Identifier: MIT
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  /** UNI-028 layout view for the Movies/Series library pages: poster grid (default) or table. */
  libraryView: "posters" | "table";
  setLibraryView: (view: "posters" | "table") => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      setTheme: (theme) => set({ theme }),
      libraryView: "posters",
      setLibraryView: (libraryView) => set({ libraryView }),
    }),
    { name: "medianexus-ui" },
  ),
);

export function applyTheme(theme: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
