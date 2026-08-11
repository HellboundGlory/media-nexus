// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Film, Tv, Star, Plus, Check, Settings } from "lucide-react";
import { api, ApiClientError } from "../api/client";
import type { DiscoverItem, DiscoverPage, DiscoverMediaType, DiscoverCategory } from "../api/types";
import { Badge, EmptyState, ErrorState, Spinner } from "../lib/ui";

const MEDIA_TABS: { key: DiscoverMediaType; label: string }[] = [
  { key: "movie", label: "Movies" },
  { key: "series", label: "TV Shows" },
];

const CATEGORIES: { key: DiscoverCategory; label: string; tvLabel?: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "popular", label: "Popular" },
  { key: "upcoming", label: "Upcoming", tvLabel: "On The Air" },
  { key: "top_rated", label: "Top Rated" },
];

export default function Discover() {
  const qc = useQueryClient();
  const [mediaType, setMediaType] = useState<DiscoverMediaType>("movie");
  const [category, setCategory] = useState<DiscoverCategory>("trending");

  const discover = useInfiniteQuery({
    queryKey: ["discover", mediaType, category],
    queryFn: ({ pageParam }) => api.get<DiscoverPage>(`/discover?mediaType=${mediaType}&category=${category}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

  const add = useMutation({
    mutationFn: (item: DiscoverItem) => api.post<{ id: string; created: boolean }>("/discover/add", { mediaType: item.mediaType, tmdbId: item.tmdbId }),
    onSuccess: (res, item) => {
      qc.setQueryData<InfiniteData<DiscoverPage>>(["discover", mediaType, category], (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            results: p.results.map((r) => (r.tmdbId === item.tmdbId ? { ...r, inLibrary: true, libraryId: res.id } : r)),
          })),
        };
      });
      qc.invalidateQueries({ queryKey: [mediaType === "movie" ? "movies" : "series"] });
    },
  });

  const notConfigured = discover.isError && discover.error instanceof ApiClientError && discover.error.code === "UNPROCESSABLE";
  const items = discover.data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Discover</h2>
        <p className="text-sm text-zinc-500">Browse TMDB for new, upcoming, and popular movies and TV shows.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-zinc-300 p-1 dark:border-zinc-700">
          {MEDIA_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setMediaType(t.key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${mediaType === t.key ? "bg-violet-600 text-white" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
            >
              {t.key === "movie" ? <Film className="h-3.5 w-3.5" /> : <Tv className="h-3.5 w-3.5" />} {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${category === c.key ? "bg-violet-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"}`}
            >
              {mediaType === "series" && c.tvLabel ? c.tvLabel : c.label}
            </button>
          ))}
        </div>
      </div>

      {notConfigured ? (
        <EmptyState
          title="TMDB isn't configured yet"
          hint="Set a TMDB API key in System → Metadata to browse and add titles from Discover."
          action={
            <Link to="/system" className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500">
              <Settings className="h-3.5 w-3.5" /> Go to System settings
            </Link>
          }
        />
      ) : discover.isError ? (
        <ErrorState error={discover.error} onRetry={() => discover.refetch()} />
      ) : discover.isLoading ? (
        <Spinner label="Loading…" />
      ) : items.length === 0 ? (
        <EmptyState title="No results" hint="Try a different category." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {items.map((item) => (
              <DiscoverCard
                key={item.tmdbId}
                item={item}
                onAdd={() => add.mutate(item)}
                adding={add.isPending && add.variables?.tmdbId === item.tmdbId}
              />
            ))}
          </div>
          {discover.hasNextPage && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => discover.fetchNextPage()}
                disabled={discover.isFetchingNextPage}
                className="rounded-lg border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {discover.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiscoverCard({ item, onAdd, adding }: { item: DiscoverItem; onAdd: () => void; adding: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="aspect-[2/3] w-full bg-zinc-100 dark:bg-zinc-800">
        {item.posterUrl ? (
          <img src={item.posterUrl} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-400">
            {item.mediaType === "movie" ? <Film className="h-8 w-8" /> : <Tv className="h-8 w-8" />}
          </div>
        )}
      </div>
      <div className="space-y-1.5 p-2.5">
        <p className="truncate text-sm font-medium" title={item.title}>{item.title}</p>
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>{item.year ?? "—"}</span>
          {item.rating != null && item.rating > 0 && (
            <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{item.rating.toFixed(1)}</span>
          )}
        </div>
        {item.inLibrary ? (
          <div className="flex justify-center">
            <Badge tone="ok"><Check className="mr-1 inline h-3 w-3" />In library</Badge>
          </div>
        ) : (
          <button
            onClick={onAdd}
            disabled={adding}
            className="flex w-full items-center justify-center gap-1 rounded-lg bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> {adding ? "Adding…" : "Add"}
          </button>
        )}
      </div>
    </div>
  );
}
