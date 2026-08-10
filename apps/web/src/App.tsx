// SPDX-License-Identifier: MIT
import { useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Movies from "./pages/Movies";
import Series from "./pages/Series";
import Activity from "./pages/Activity";
import Requests from "./pages/Requests";
import Indexers from "./pages/Indexers";
import Clients from "./pages/Clients";
import System from "./pages/System";
import { applyTheme, useAppStore } from "./store/useAppStore";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

export default function App() {
  const theme = useAppStore((s) => s.theme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="movies" element={<Movies />} />
            <Route path="series" element={<Series />} />
            <Route path="activity" element={<Activity />} />
            <Route path="requests" element={<Requests />} />
            <Route path="indexers" element={<Indexers />} />
            <Route path="clients" element={<Clients />} />
            <Route path="system" element={<System />} />
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  );
}
