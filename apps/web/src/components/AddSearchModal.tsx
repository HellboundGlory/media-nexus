// SPDX-License-Identifier: MIT
// AddSearchModal — UNI-029 pass 2: the wide, live-search "Add" modal shared by Movies and Series.
// Replaces the old crude title + optional numeric-id quick-add form. Search results come from
// /metadata/search, which returns SearchResult (a MediaSummary annotated with inLibrary/libraryId
// + a rating) — the externalId is the TMDB id as a string, and the poster lives in `images`
// (resolved via the posterUrl helper). The "+ Add" flow goes through POST /discover/add (NOT
// /movies|/series create): that endpoint resolves a real tvdbId for series (without it the
// tvdbId-requiring season/episode backfill is silently skipped) and computes minimumAvailability
// server-side for movies. Because /discover/add requires a real tmdbId, there is no "type any
// title with no TMDB match" fallback anymore — matching upstream, you can only add a real
// search result.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Star, Plus, Check, Film, Tv } from "lucide-react";
import { api } from "../api/client";
import { Modal } from "./Modal";
import { AddTitleModal, type AddTitleBody } from "./AddTitleModal";
import { posterUrl } from "./detail/Poster";

/** The /metadata/search result shape (mirrors the API's SearchResult). */
interface SearchResult {
  externalId: string;
  title: string;
  year?: number;
  overview?: string;
  images?: { coverType: string; url: string }[];
  rating?: number;
  inLibrary: boolean;
  libraryId: string | null;
}

export function AddSearchModal({
  mediaType,
  onClose,
}: {
  mediaType: "movie" | "series";
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [addHit, setAddHit] = useState<SearchResult | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());

  // Debounced live search — same precedent as FolderBrowserModal (UNI-012), so fast typing
  // doesn't hammer /metadata/search.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const results = useQuery({
    queryKey: ["metadata-search", mediaType, debounced],
    queryFn: () => api.get<SearchResult[]>(`/metadata/search?query=${encodeURIComponent(debounced)}&type=${mediaType}`),
    enabled: debounced.length > 0,
  });

  const add = useMutation({
    mutationFn: ({ hit, body }: { hit: SearchResult; body: AddTitleBody }) =>
      api.post<{ id: string; created: boolean }>("/discover/add", { mediaType, tmdbId: Number(hit.externalId), ...body }),
    onSuccess: (_, { hit }) => {
      qc.invalidateQueries({ queryKey: [mediaType === "movie" ? "movies" : "series"] });
      // Flip this result to the "In library" state immediately for the rest of the session.
      setAdded((prev) => new Set(prev).add(Number(hit.externalId)));
      setAddHit(null);
    },
  });

  // True when the backend already knows the title is in the library (inLibrary) or we added it
  // this session — preventing accidental duplicate adds is the whole point of the flag.
  const inLibrary = (h: SearchResult) => h.inLibrary || added.has(Number(h.externalId));
  const plural = mediaType === "movie" ? "movie" : "series";

  return (
    <>
      <Modal
        title={`Add ${mediaType}`}
        onClose={onClose}
        wide
        footer={
          <button onClick={onClose} className="rounded-lg border border-rule bg-bg px-3 py-1.5 text-sm text-ink hover:bg-rule">Close</button>
        }
      >
        <div className="space-y-3 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search TMDB for a ${plural}…`}
              autoFocus
              className="w-full rounded-lg border border-rule bg-surface px-3 py-1.5 pl-8 pr-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <div className="max-h-[55vh] space-y-1 overflow-y-auto">
            {debounced.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-dim">Type to search TMDB.</p>
            ) : results.isFetching ? (
              <p className="py-6 text-center text-sm text-ink-dim">Searching…</p>
            ) : results.isError ? (
              <p className="py-6 text-center text-sm text-err">Search failed. Try again.</p>
            ) : (results.data ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-dim">No results.</p>
            ) : (
              (results.data ?? []).map((h) => {
                const url = posterUrl(h.images);
                return (
                  <div key={h.externalId} className="flex items-center gap-3 rounded-lg border border-rule bg-surface p-2">
                    {url ? (
                      <img src={url} alt={h.title} loading="lazy" className="h-20 w-14 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded bg-track text-ink-dim">
                        {mediaType === "movie" ? <Film className="h-5 w-5" /> : <Tv className="h-5 w-5" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-ink">{h.title}</p>
                        {h.year != null && h.year > 0 && <span className="shrink-0 text-xs text-ink-dim">{h.year}</span>}
                        {h.rating != null && h.rating > 0 && (
                          <span className="flex shrink-0 items-center gap-0.5 text-xs text-accent"><Star className="h-3 w-3 fill-accent" />{h.rating.toFixed(1)}</span>
                        )}
                      </div>
                      {h.overview && <p className="line-clamp-2 text-xs text-ink-dim">{h.overview}</p>}
                    </div>
                    {inLibrary(h) ? (
                      <span className="flex shrink-0 items-center gap-1 rounded-lg border border-rule px-2.5 py-1 text-xs font-semibold text-ink-dim"><Check className="h-3.5 w-3.5" /> In library</span>
                    ) : (
                      <button onClick={() => setAddHit(h)} className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-accent-ink hover:bg-accent/90"><Plus className="h-3.5 w-3.5" /> Add</button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Modal>

      {addHit && (
        <AddTitleModal
          mediaType={mediaType}
          title={addHit.title}
          posterUrl={posterUrl(addHit.images)}
          overview={addHit.overview}
          isPending={add.isPending}
          error={add.error}
          // Movies MUST lock Minimum Availability here: /discover/add computes it server-side from
          // TMDB's real release date, so an editable field would be a silent no-op (same as Discover).
          lockMinimumAvailability={mediaType === "movie"}
          onClose={() => setAddHit(null)}
          onSubmit={(body) => add.mutate({ hit: addHit, body })}
        />
      )}
    </>
  );
}
