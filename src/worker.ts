/**
 * SVBC Eventbrite Events Proxy — Cloudflare Worker
 *
 * Proxies requests to the Eventbrite API v3, keeping the private OAuth token
 * server-side. Responses are edge-cached via the Cloudflare Cache API so the
 * vast majority of requests never reach Eventbrite.
 *
 * Routes:
 *   GET /        → redirects to /events
 *   GET /events  → returns upcoming SVBC events as JSON
 *   OPTIONS *    → CORS preflight
 *
 * @see https://www.eventbrite.com/platform/api
 */

/** Base URL for the Eventbrite REST API v3. */
const EVENTBRITE_API = "https://www.eventbriteapi.com/v3";

/** Origins permitted to call this worker (checked on every request). */
const ALLOWED_ORIGINS: string[] = [
  "https://www.bikesiliconvalley.org",
  "https://bikesiliconvalley.org",
  "http://localhost",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Environment bindings declared in wrangler.toml + secrets. */
interface Env {
  /** Eventbrite organization whose events are listed. */
  EVENTBRITE_ORG_ID: string;
  /** Edge-cache lifetime in seconds (default 900 = 15 min). */
  CACHE_TTL: string;
  /** Eventbrite private OAuth token (set via `wrangler secret put`). */
  EVENTBRITE_TOKEN: string;
}

/** Venue info returned to the client. */
interface EventVenue {
  name: string;
  city: string;
  address: string;
}

/** Simplified event object returned by this API. */
interface EventItem {
  name: string;
  url: string;
  start: { timezone: string; local: string; utc: string };
  end: { timezone: string; local: string; utc: string };
  is_free: boolean;
  online_event: boolean;
  summary: string;
  logo_url: string | null;
  venue: EventVenue | null;
}

/** Shape of the JSON body returned on success. */
interface EventsResponse {
  events: EventItem[];
  total: number;
}

/** Shape of the JSON body returned on error. */
interface ErrorResponse {
  error: string;
  status?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  /**
   * Handles every incoming request.
   *
   * 1. CORS preflight is answered immediately.
   * 2. Non-GET methods are rejected.
   * 3. Only `/` and `/events` are valid paths.
   * 4. A cache-first strategy serves events from the edge whenever possible;
   *    on a miss the worker fetches from Eventbrite and populates the cache.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return handleCORS(request, new Response(null, { status: 204 }));
    }

    if (request.method !== "GET") {
      return handleCORS(
        request,
        new Response("Method not allowed", { status: 405 }),
      );
    }

    const url = new URL(request.url);

    if (url.pathname !== "/" && url.pathname !== "/events") {
      return handleCORS(
        request,
        jsonResponse({ error: "Not found. Use /events" }, 404),
      );
    }

    try {
      const pageSize = Math.min(
        parseInt(url.searchParams.get("page_size") || "20", 10),
        50,
      );
      const cacheTTL = parseInt(env.CACHE_TTL || "900", 10);

      // Canonical cache key — normalized so CORS origin variance doesn't
      // fragment the cache.
      const cacheKey = new Request(
        `${url.origin}/events?page_size=${pageSize}`,
        { method: "GET" },
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

      // 3. Write to cache in the background (only for successful responses)
      if (fresh.ok) {
        const toCache = fresh.clone();
        toCache.headers.set("Cache-Control", `public, max-age=${cacheTTL}`);
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }

      return handleCORS(request, fresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return handleCORS(
        request,
        jsonResponse({ error: "Internal error", detail: message }, 500),
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Eventbrite fetching
// ---------------------------------------------------------------------------

/**
 * Fetches live/upcoming events from the Eventbrite API for the configured
 * organization. Returns a JSON {@link Response} with an {@link EventsResponse}
 * body on success, or an {@link ErrorResponse} on failure.
 *
 * @param env      - Worker environment bindings
 * @param pageSize - Maximum number of events to return (1–50)
 * @param cacheTTL - Cache-Control max-age to set on the response
 */
async function fetchEvents(
  env: Env,
  pageSize: number,
  cacheTTL: number,
): Promise<Response> {
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
      apiRes.status,
    );
  }

  const data = await apiRes.json<{
    events?: Array<Record<string, any>>;
    pagination?: { object_count?: number };
  }>();

  const events: EventItem[] = (data.events || []).map((evt) => ({
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

  const response: EventsResponse = {
    events,
    total: data.pagination?.object_count || events.length,
  };

  return jsonResponse(response, 200, {
    "Cache-Control": `public, max-age=${cacheTTL}`,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a JSON {@link Response} with the correct content-type header.
 *
 * @param body         - Object to serialize as JSON
 * @param status       - HTTP status code (default 200)
 * @param extraHeaders - Additional headers to include
 */
function jsonResponse(
  body: EventsResponse | ErrorResponse,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Appends CORS headers to a response based on the request's Origin header.
 * Only origins in {@link ALLOWED_ORIGINS} (or empty/missing origins) receive
 * an explicit `Access-Control-Allow-Origin`.
 */
function handleCORS(request: Request, response: Response): Response {
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
