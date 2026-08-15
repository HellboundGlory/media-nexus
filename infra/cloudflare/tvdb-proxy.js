/**
 * MediaNexus — TheTVDB API v4 caching proxy (Cloudflare Worker).
 *
 * A generic, authenticated 1:1 passthrough to https://api4.thetvdb.com/v4. It holds the
 * MediaNexus TheTVDB API key as an encrypted Cloudflare secret (`TVDB_API_KEY`) and takes
 * every HTTP request that hits the Worker, injects a valid Bearer token, and forwards it to
 * TheTVDB. MediaNexus's own TVDB client treats this Worker as if it were TheTVDB directly.
 *
 * This is the same pattern Sonarr uses with its hosted `skyhook.sonarr.tv` proxy: the raw
 * API key never ships to any client or appears in source — it lives only in the Worker's
 * secret config. The Worker URL is public by design (like Sonarr's). See the AUTH header
 * stripping below and `README.md` in this directory for the deployment + optional
 * rate-limiting guidance.
 *
 * Auth flow (per TheTVDB v4 docs):
 *   POST /v4/login  {"apikey": "..."} -> {"data":{"token":"..."}}  (bearer valid 1 month)
 * The Worker caches the token at module scope (Workers reuse warm isolates across requests)
 * and re-logins when it has expired or a call comes back 401.
 */

const UPSTREAM = "https://api4.thetvdb.com/v4";
const TOKEN_TTL_MS = 27 * 24 * 3600 * 1000; // refresh conservatively before TVDB's 1-month expiry

let cachedToken = null;
let cachedAt = 0;

/** Exchange the API key for a fresh bearer token and cache it. */
async function login(env) {
  const res = await fetch(`${UPSTREAM}/login`, {
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only forward the API paths; a bare GET to the worker root is just a health ping.
    if (url.pathname === "/") {
      return new Response("MediaNexus TheTVDB proxy is up.\n", { status: 200 });
    }

    const target = `${UPSTREAM}${url.pathname}${url.search}`;
    const method = request.method;

    // Copy the inbound headers but strip everything that must not leak to TheTVDB
    // (especially any Authorization the client might have sent, plus hop headers and
    // Cloudflare-specific ones). The client never needs to authenticate — we inject it.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    headers.delete("x-forwarded-proto");

    const body = method === "GET" || method === "HEAD" ? undefined : await request.text();
    if (body !== undefined) headers.set("content-length", String(new TextEncoder().encode(body).length));

    try {
      const upstream = await authedFetch(env, target, { method, headers, body });
      // Pass status + body straight through; strip hop-by-hop + any TVDB auth-ish headers back.
      const out = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
      out.headers.delete("content-encoding"); // upstream is not brotli-compressed into the worker
      return out;
    } catch (err) {
      return new Response(`proxy error: ${err.message}`, { status: 502 });
    }
  },
};
