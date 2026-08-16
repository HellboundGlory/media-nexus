// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { HashRouter, Routes, Route, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Discover from "./pages/Discover";
import Movies from "./pages/Movies";
import Series from "./pages/Series";
import Activity from "./pages/Activity";
import Downloads from "./pages/Downloads";
import Wanted from "./pages/Wanted";
import Settings from "./pages/Settings";
import SeriesDetail from "./pages/SeriesDetail";
import MovieDetail from "./pages/MovieDetail";
import Calendar from "./pages/Calendar";
import System from "./pages/System";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import { applyTheme, useAppStore } from "./store/useAppStore";
import { subscribeEvents, eventTypeToQueryKeys } from "./api/events";
import { api } from "./api/client";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

/** Live SSE subscriber: refreshes affected queries when domain events arrive. */
function EventBridge() {
  const qc = useQueryClient();
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
  }, [qc]);
  return null;
}

/** Gates the main app tree: redirects to /setup (no admin account yet) or /login (not authenticated). */
function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<{ setupRequired: boolean }>("/auth/status");
        if (cancelled) return;
        if (status.setupRequired) { navigate("/setup", { replace: true }); return; }
        // throws (and is redirected to /login by client.ts's global 401 handler) if not authenticated
        await api.get("/auth/whoami");
        if (cancelled) return;
        setReady(true);
      } catch {
        // handled above, or a genuine network error either way — don't render the authenticated tree
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);
  if (!ready) return null;
  return <>{children}</>;
}

export default function App() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <AuthGate>
                <EventBridge />
                <Layout />
              </AuthGate>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="discover" element={<Discover />} />
            <Route path="movies" element={<Movies />} />
            <Route path="movies/:id" element={<MovieDetail />} />
            <Route path="series" element={<Series />} />
            <Route path="series/:id" element={<SeriesDetail />} />
            <Route path="downloads" element={<Downloads />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="activity" element={<Activity />} />
            <Route path="wanted" element={<Wanted />} />
            <Route path="settings" element={<Settings />} />
            <Route path="system" element={<System />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
