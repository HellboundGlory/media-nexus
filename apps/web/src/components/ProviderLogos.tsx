// SPDX-License-Identifier: MIT
// Self-contained inline-SVG brand marks for the Settings > Metadata Source attribution cards
// (TRIAGE Tier 5 #19). No external image/CDN calls — this app is LAN-only. Geometry is an
// original simplified recreation of each provider's public mark (circle motif for TMDB, teal
// "tv" badge for TheTVDB), not a traced copy of their vector assets.

export function TmdbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 190 40" role="img" aria-label="TMDB" className={className}>
      <g transform="translate(0,4)">
        <circle cx="16" cy="16" r="15" fill="#90cea1" />
        <circle cx="26" cy="16" r="15" fill="#01b4e4" fillOpacity="0.85" />
        <circle cx="21" cy="26" r="15" fill="#0d253f" fillOpacity="0.75" />
      </g>
      <text x="52" y="24" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="20" letterSpacing="0.5" fill="currentColor">
        TMDB
      </text>
      <text x="52" y="36" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="600" fontSize="7" letterSpacing="1.5" fill="currentColor" opacity="0.6">
        THE MOVIE DATABASE
      </text>
    </svg>
  );
}

export function TvdbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 190 40" role="img" aria-label="TheTVDB" className={className}>
      <rect x="0" y="4" width="32" height="32" rx="7" fill="#6cc1a1" />
      <text x="16" y="26" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="15" fill="#0d1f1a">
        tv
      </text>
      <text x="42" y="26" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="18" fill="#6cc1a1">
        The<tspan fill="currentColor" opacity="0.85">TVDB</tspan>
      </text>
    </svg>
  );
}
