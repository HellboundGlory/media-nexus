// SPDX-License-Identifier: MIT
// CastCrewStrip — horizontal scrollable strip of cast (then crew) with real headshots from
// `profileUrl`, falling back to a person-silhouette when TMDB has no photo (common for crew).
// Fetches GET /movies|series/:id/credits itself. Empty state is intentional, not broken.
import { useQuery } from "@tanstack/react-query";
import { User } from "lucide-react";
import { api } from "../../api/client";
import type { Credit, CreditsResponse } from "../../api/types";
import { EmptyState, ErrorState } from "../../lib/ui";

function PersonCard({ c, sub }: { c: Credit; sub?: string }) {
  return (
    <div className="flex w-28 shrink-0 flex-col items-center gap-1.5">
      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-rule bg-bg">
        {c.profileUrl ? (
          <img src={c.profileUrl} alt={c.personName} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <User className="h-6 w-6 text-ink-dim" />
        )}
      </div>
      <div className="w-full truncate text-center text-xs font-semibold text-ink" title={c.personName}>{c.personName}</div>
      {sub && <div className="w-full truncate text-center text-[10px] uppercase tracking-wide text-ink-dim" title={sub}>{sub}</div>}
    </div>
  );
}

export function CastCrewStrip({ mediaType, mediaId }: { mediaType: "movie" | "series"; mediaId: string }) {
  const credits = useQuery({
    queryKey: ["credits", mediaType, mediaId],
    queryFn: () => api.get<CreditsResponse>(`/${mediaType === "movie" ? "movies" : "series"}/${mediaId}/credits`),
  });

  if (credits.isLoading) return <div className="h-24" />;
  if (credits.isError) return <ErrorState error={credits.error} onRetry={() => credits.refetch()} />;
  const { cast = [], crew = [] } = credits.data ?? {};
  if (cast.length === 0 && crew.length === 0) {
    return (
      <section>
        <h4 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Cast & Crew</h4>
        <EmptyState title="No cast & crew yet" hint="Credits appear after a metadata refresh." />
      </section>
    );
  }
  return (
    <section className="space-y-4">
      {cast.length > 0 && (
        <div>
          <h4 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Cast</h4>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {cast.map((c) => <PersonCard key={c.id} c={c} sub={c.character ?? undefined} />)}
          </div>
        </div>
      )}
      {crew.length > 0 && (
        <div>
          <h4 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.05em] text-ink-dim">Crew</h4>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {crew.map((c) => <PersonCard key={c.id} c={c} sub={c.job ?? undefined} />)}
          </div>
        </div>
      )}
    </section>
  );
}
