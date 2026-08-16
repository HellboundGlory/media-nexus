// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Film, Tv, Star, Plus, Check, Settings } from "lucide-react";
import { api, ApiClientError } from "../api/client";
import type { DiscoverItem, DiscoverPage, DiscoverMediaType, DiscoverCategory } from "../api/types";
import { Badge, EmptyState, ErrorState, Spinner } from "../lib/ui";
import { AddTitleModal, type AddTitleBody } from "../components/AddTitleModal";

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
  const [addModal, setAddModal] = useState<DiscoverItem | null>(null);

  const discover = useInfiniteQuery({
    queryKey: ["discover", mediaType, category],
    queryFn: ({ pageParam }) => api.get<DiscoverPage>(`/discover?mediaType=${mediaType}&category=${category}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });

  const add = useMutation({
    // QUALITYPROFILES-1: the add modal's fields ride along on POST /discover/add, which now
    // accepts qualityProfileId/rootFolderPath/tags/seriesType and threads them into create.
    mutationFn: (vars: { item: DiscoverItem; body: AddTitleBody }) =>
      api.post<{ id: string; created: boolean }>("/discover/add", {
        mediaType: vars.item.mediaType, tmdbId: vars.item.tmdbId, ...vars.body,
      }),
    onSuccess: (res, vars) => {
      const item = vars.item;
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
      setAddModal(null);
    },
  });

  const notConfigured = discover.isError && discover.error instanceof ApiClientError && discover.error.code === "UNPROCESSABLE";
  const items = discover.data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-bold uppercase tracking-[0.05em] text-ink">Discover</h2>
        <p className="text-sm text-ink-dim">Browse TMDB for new, upcoming, and popular movies and TV shows.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-rule bg-surface p-1">
          {MEDIA_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setMediaType(t.key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-display font-semibold uppercase tracking-wide transition-colors ${mediaType === t.key ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-bg hover:text-ink"}`}
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
              className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${category === c.key ? "bg-accent text-accent-ink" : "bg-neutral-bg text-neutral-ink hover:bg-rule hover:text-ink"}`}
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
            <Link to="/system" className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90">
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
                onAdd={() => setAddModal(item)}
                adding={false}
              />
            ))}
          </div>
          {discover.hasNextPage && (
            <div className="flex justify-center pt-2">
              <button
                onClick={() => discover.fetchNextPage()}
                disabled={discover.isFetchingNextPage}
                className="rounded-lg border border-rule bg-surface px-4 py-1.5 text-sm font-medium text-ink hover:bg-rule disabled:opacity-50"
              >
                {discover.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}

      {addModal && (
        <AddTitleModal
          mediaType={addModal.mediaType}
          title={addModal.title}
          posterUrl={addModal.posterUrl}
          overview={addModal.overview}
          isPending={add.isPending}
          error={add.error}
          lockMinimumAvailability={addModal.mediaType === "movie"}
          onClose={() => setAddModal(null)}
          onSubmit={(body) => add.mutate({ item: addModal, body })}
        />
      )}
    </div>
  );
}

function DiscoverCard({ item, onAdd, adding }: { item: DiscoverItem; onAdd: () => void; adding: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-surface">
      <div className="aspect-[2/3] w-full bg-track">
        {item.posterUrl ? (
          <img src={item.posterUrl} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-dim">
            {item.mediaType === "movie" ? <Film className="h-8 w-8" /> : <Tv className="h-8 w-8" />}
          </div>
        )}
      </div>
      <div className="space-y-1.5 p-2.5">
        <p className="truncate text-sm font-medium text-ink" title={item.title}>{item.title}</p>
        <div className="flex items-center justify-between text-xs text-ink-dim">
          <span>{item.year ?? "—"}</span>
          {item.rating != null && item.rating > 0 && (
            <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-accent text-accent" />{item.rating.toFixed(1)}</span>
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
            className="flex w-full items-center justify-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> {adding ? "Adding…" : "Add"}
          </button>
        )}
      </div>
    </div>
  );
}
