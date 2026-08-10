// SPDX-License-Identifier: MIT
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppState {
  theme: "dark" | "light";
  apiKey: string;
  setTheme: (theme: "dark" | "light") => void;
  setApiKey: (key: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      apiKey: "",
      setTheme: (theme) => set({ theme }),
      setApiKey: (apiKey) => set({ apiKey }),
    }),
    { name: "medianexus-ui" },
  ),
);

export function applyTheme(theme: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}
