/**
 * MediaNexus — consolidated Cloudflare Worker proxy for TheTVDB v4 and TheMovieDB v3.
 *
 * ONE worker serves both metadata backends (the previous `medianexus-tvdb-proxy` was renamed to
 * this single `medianexus-proxy`). It holds BOTH keys as encrypted Cloudflare secrets:
 *   - `TVDB_API_KEY` — TheTVDB v4 (used to fetch a short-lived bearer token)
 *   - `TMDB_API_KEY` — TheMovieDB v3 (injected as an `api_key` query param)
 * Routing is by path prefix:
 *   - `/tvdb/*`   -> forwards to https://api4.thetvdb.com/v4/*   (strips the `/tvdb` prefix)
 *   - `/tmdb/*`   -> forwards to https://api.themoviedb.org/3/*  (strips the `/tmdb` prefix, then
 *                     appends/injects `?api_key=` — the client never sends its own)
 * A bare GET to `/` is just a health ping.
 *
 * This is the same pattern Sonarr uses with its hosted `skyhook.sonarr.tv` proxy: the raw API keys
 * never ship to any client or appear in source — they live only in the Worker's secret config. The
 * Worker URL is public by design (like Sonarr's). MediaNexus's TVDB/TMDB clients treat this Worker
 * as if it were the upstream API directly. See `README.md` in this directory for deployment +
 * optional rate-limiting guidance.
 *
 * TheTVDB auth flow (per v4 docs):
 *   POST /v4/login  {"apikey": "..."} -> {"data":{"token":"..."}}  (bearer valid 1 month)
 * The Worker caches the token at module scope (Workers reuse warm isolates across requests) and
 * re-logins when it has expired or a call comes back 401.
 */

const TVDB_UPSTREAM = "https://api4.thetvdb.com/v4";
const TMDB_UPSTREAM = "https://api.themoviedb.org/3";
const TOKEN_TTL_MS = 27 * 24 * 3600 * 1000; // refresh conservatively before TVDB's 1-month expiry

let cachedToken = null;
let cachedAt = 0;

/** Exchange the TVDB API key for a fresh bearer token and cache it. */
async function login(env) {
  const res = await fetch(`${TVDB_UPSTREAM}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: env.TVDB_API_KEY }),
  });
  if (!res.ok) {
    throw new Error(`TheTVDB login failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const token = json && json.data && json.data.token;
  if (!token) throw new Error("TheTVDB login succeeded but returned no token");
  cachedToken = token;
  cachedAt = Date.now();
  return token;
}

function validToken() {
  return cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS ? cachedToken : null;
}

/** Fetch with a valid Bearer token; retry once with a fresh login on a 401. */
async function authedFetch(env, url, init) {
  const token = validToken() || (await login(env));
  const withAuth = (tok) => ({ ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${tok}` } });

  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    const fresh = await login(env);
    res = await fetch(url, withAuth(fresh));
  }
  return res;
}

/** Copy the inbound headers but strip everything that must not leak upstream (any Authorization the
 *  client might have sent, hop headers, and Cloudflare-specific ones). They never authenticate. */
function stripHeaders(headers) {
  const out = new Headers(headers);
  for (const h of [
    "authorization", "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
    "x-forwarded-for", "x-real-ip", "x-forwarded-proto",
  ]) {
    out.delete(h);
  }
  return out;
}

/** Pass the upstream status + body straight through; strip hop-by-hop + any upstream auth-ish headers. */
function passthrough(upstream) {
  const out = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  out.headers.delete("content-encoding"); // upstream is not brotli-compressed into the worker
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A bare GET to the worker root is just a health ping — list the available routes.
    if (url.pathname === "/") {
      return new Response("MediaNexus proxy is up. Routes: /tvdb/*, /tmdb/*\n", { status: 200 });
    }

    const headers = stripHeaders(request.headers);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    if (body !== undefined) headers.set("content-length", String(new TextEncoder().encode(body).length));

    try {
      if (url.pathname.startsWith("/tvdb/")) {
        const target = `${TVDB_UPSTREAM}${url.pathname.slice("/tvdb".length)}${url.search}`;
        const upstream = await authedFetch(env, target, { method: request.method, headers, body });
        return passthrough(upstream);
      }

      if (url.pathname.startsWith("/tmdb/")) {
        if (!env.TMDB_API_KEY) {
          return new Response("TMDB_API_KEY secret is not set", { status: 502 });
        }
        const target = new URL(`${TMDB_UPSTREAM}${url.pathname.slice("/tmdb".length)}${url.search}`);
        // The client never supplies its own key — the Worker injects the real one.
        target.searchParams.set("api_key", env.TMDB_API_KEY);
        const upstream = await fetch(target.toString(), { method: request.method, headers, body });
        return passthrough(upstream);
      }

      return new Response("Not found. Use /tvdb/* or /tmdb/*", { status: 404 });
    } catch (err) {
      return new Response(`proxy error: ${err.message}`, { status: 502 });
    }
  },
};
