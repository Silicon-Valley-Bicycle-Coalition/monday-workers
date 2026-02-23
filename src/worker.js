/**
 * SVBC Eventbrite Events Proxy — Cloudflare Worker (with Edge Cache)
 *
 * Proxies requests to the Eventbrite API, keeping the private token
 * server-side. Uses the Cloudflare Cache API so the Worker only calls
 * Eventbrite when the cache has expired.
 *
 * Environment variables (set in wrangler.toml [vars]):
 *   EVENTBRITE_ORG_ID  — Eventbrite organization ID
 *   CACHE_TTL          — Edge cache lifetime in seconds
 *
 * Secrets (set via `npx wrangler secret put`):
 *   EVENTBRITE_TOKEN   — Eventbrite private OAuth token
 */

const EVENTBRITE_API = "https://www.eventbriteapi.com/v3";

const ALLOWED_ORIGINS = [
  "https://www.bikesiliconvalley.org",
  "https://bikesiliconvalley.org",
  "http://localhost",
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleCORS(request, new Response(null, { status: 204 }));
    }

    if (request.method !== "GET") {
      return handleCORS(request, new Response("Method not allowed", { status: 405 }));
    }

    const url = new URL(request.url);

    if (url.pathname !== "/" && url.pathname !== "/events") {
      return handleCORS(request, jsonResponse({ error: "Not found. Use /events" }, 404));
    }

    try {
      const pageSize = Math.min(
        parseInt(url.searchParams.get("page_size") || "20", 10),
        50
      );
      const cacheTTL = parseInt(env.CACHE_TTL || "900", 10);

      // Canonical cache key (normalized, ignoring CORS origin variance)
      const cacheKey = new Request(
        `${url.origin}/events?page_size=${pageSize}`,
        { method: "GET" }
      );

      const cache = caches.default;

      // 1. Check edge cache
      const cached = await cache.match(cacheKey);
      if (cached) {
        const response = new Response(cached.body, cached);
        response.headers.set("X-Cache", "HIT");
        return handleCORS(request, response);
      }

      // 2. Cache MISS — fetch from Eventbrite
      const fresh = await fetchEvents(env, pageSize, cacheTTL);
      fresh.headers.set("X-Cache", "MISS");

      // 3. Write to cache in the background
      if (fresh.ok) {
        const toCache = fresh.clone();
        toCache.headers.set("Cache-Control", `public, max-age=${cacheTTL}`);
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return handleCORS(request, fresh);
    } catch (err) {
      return handleCORS(
        request,
        jsonResponse({ error: "Internal error", detail: err.message }, 500)
      );
    }
  },
};

async function fetchEvents(env, pageSize, cacheTTL) {
  const apiUrl =
    `${EVENTBRITE_API}/organizations/${env.EVENTBRITE_ORG_ID}/events/` +
    `?expand=venue&page_size=${pageSize}` +
    `&status=live&time_filter=current_future&order_by=start_asc`;

  const apiRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${env.EVENTBRITE_TOKEN}` },
  });

  if (!apiRes.ok) {
    const body = await apiRes.text();
    return jsonResponse(
      { error: "Eventbrite API error", status: apiRes.status, detail: body },
      apiRes.status
    );
  }

  const data = await apiRes.json();

  const events = (data.events || []).map((evt) => ({
    name: evt.name?.text || evt.name?.html || "Untitled",
    url: evt.url,
    start: evt.start,
    end: evt.end,
    is_free: evt.is_free,
    online_event: evt.online_event,
    summary: evt.summary || evt.description?.text?.substring(0, 300) || "",
    logo_url: evt.logo?.url || null,
    venue: evt.venue
      ? {
          name: evt.venue.name,
          city: evt.venue.address?.city || "",
          address: evt.venue.address?.localized_address_display || "",
        }
      : null,
  }));

  return jsonResponse(
    { events, total: data.pagination?.object_count || events.length },
    200,
    { "Cache-Control": `public, max-age=${cacheTTL}` }
  );
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function handleCORS(request, response) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers(response.headers);

  if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o)) || origin === "") {
    headers.set("Access-Control-Allow-Origin", origin || "*");
  } else {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, { status: response.status, headers });
}
