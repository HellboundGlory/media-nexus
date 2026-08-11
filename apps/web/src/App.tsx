// SPDX-License-Identifier: MIT
import { useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Discover from "./pages/Discover";
import Movies from "./pages/Movies";
import Series from "./pages/Series";
import Activity from "./pages/Activity";
import Indexers from "./pages/Indexers";
import Clients from "./pages/Clients";
import SeriesDetail from "./pages/SeriesDetail";
import Calendar from "./pages/Calendar";
import System from "./pages/System";
import { applyTheme, useAppStore } from "./store/useAppStore";
import { subscribeEvents, eventTypeToQueryKeys } from "./api/events";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

/** Live SSE subscriber: refreshes affected queries when domain events arrive. */
function EventBridge() {
  const qc = useQueryClient();
  const apiKeyActive = useAppStore((s) => s.apiKey);
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: number | undefined;
    const loop = async () => {
      if (ctrl.signal.aborted) return;
      try {
        await subscribeEvents({
          signal: ctrl.signal,
          onEvent: (event) => {
            for (const key of eventTypeToQueryKeys(event.type)) void qc.invalidateQueries({ queryKey: [key] });
          },
        });
      } catch { /* stream closed */ }
      if (!ctrl.signal.aborted) {
        timer = window.setTimeout(() => void loop(), 4000);
      }
    };
    void loop();
    return () => { if (timer) clearTimeout(timer); ctrl.abort(); };
  }, [qc, apiKeyActive]);
  return null;
}

export default function App() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <EventBridge />
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="discover" element={<Discover />} />
            <Route path="movies" element={<Movies />} />
            <Route path="series" element={<Series />} />
            <Route path="series/:id" element={<SeriesDetail />} />
            <Route path="activity" element={<Activity />} />
            <Route path="indexers" element={<Indexers />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="clients" element={<Clients />} />
            <Route path="system" element={<System />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
