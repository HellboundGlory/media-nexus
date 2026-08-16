// SPDX-License-Identifier: MIT
// Poster — real poster image from the media row's images[].coverType === "poster" entry,
// falling back to a gradient + initials block only when no poster exists yet (title hasn't
// had a metadata refresh, or TMDB has no artwork).

export function posterUrl(images?: { coverType: string; url: string }[]): string | null {
  return images?.find((i) => i.coverType === "poster")?.url ?? null;
}

const BG = [
  "from-accent/60 to-surface",
  "from-ok/50 to-surface",
  "from-warn/50 to-surface",
  "from-err/50 to-surface",
];

function initials(title?: string): string {
  return (title ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Poster({ title, images, className }: { title?: string; images?: { coverType: string; url: string }[]; className?: string }) {
  const url = posterUrl(images);
  const bg = BG[(title?.length ?? 0) % BG.length];
  return (
    <div className={`flex h-64 w-44 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-rule bg-surface ${className ?? ""}`}>
      {url ? (
        <img src={url} alt={title ?? ""} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br font-display text-3xl font-bold uppercase tracking-wide text-ink ${bg}`}>
          {initials(title) || "?"}
        </div>
      )}
    </div>
  );
}
