/**
 * SVBC Eventbrite Events Proxy — Cloudflare Worker
 *
 * Proxies requests to the Eventbrite API v3, keeping the private OAuth token
 * server-side. Responses are edge-cached via the Cloudflare Cache API so the
 * vast majority of requests never reach Eventbrite.
 *
 * Routes:
 *   GET /        → same as /events
 *   GET /events  → returns upcoming SVBC events as JSON
 *   GET /widget  → returns embeddable HTML page (for iframe use)
 *   OPTIONS *    → CORS preflight
 *
 * All routes accept an optional `organizer` query param to filter events by
 * Eventbrite organizer profile. Must be in ALLOWED_ORGANIZERS. Without it,
 * all events for the organization are returned.
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

/** Eventbrite organizer IDs allowed via the `organizer` query param. */
const ALLOWED_ORGANIZERS: string[] = [
  "21763925459",   // Silicon Valley Bicycle Coalition (main)
  "17135810858",   // Silicon Valley Bicycle Coalition (volunteering)
  "121346572357",  // Silicon Valley Bicycle Coalition (bike parking)
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
  /** Bump to invalidate the edge cache on deploy. */
  CACHE_VERSION: string;
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
   * 3. `/widget` serves the embeddable HTML page.
   * 4. `/` and `/events` return JSON via a cache-first strategy;
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

    // Optional organizer filter: restricts events to a single Eventbrite
    // organizer profile within the org. Validated against an allowlist.
    const organizerId = url.searchParams.get("organizer");

    if (organizerId && !ALLOWED_ORGANIZERS.includes(organizerId)) {
      return handleCORS(
        request,
        jsonResponse({ error: "Unknown organizer ID" }, 400),
      );
    }

    if (url.pathname === "/widget") {
      return handleCORS(request, widgetResponse(url, organizerId));
    }

    if (url.pathname !== "/" && url.pathname !== "/events") {
      return handleCORS(
        request,
        jsonResponse({ error: "Not found. Use /events or /widget" }, 404),
      );
    }

    try {
      const pageSize = Math.min(
        parseInt(url.searchParams.get("page_size") || "20", 10),
        50,
      );
      const cacheTTL = parseInt(env.CACHE_TTL || "900", 10);

      // Canonical cache key — normalized so CORS origin variance doesn't
      // fragment the cache. Includes CACHE_VERSION and organizer so bumping/changing busts stale entries.
      const version = env.CACHE_VERSION || "0";
      const cacheKey = new Request(
        `${url.origin}/events?page_size=${pageSize}&organizer=${organizerId || "all"}&v=${version}`,
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
      const fresh = await fetchEvents(env, organizerId, pageSize, cacheTTL);
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
  organizerId: string | null,
  pageSize: number,
  cacheTTL: number,
): Promise<Response> {
  // Fetch more events than requested when filtering by organizer, since we
  // filter after the API response and need enough candidates.
  const fetchSize = organizerId ? 50 : pageSize;
  const apiUrl =
    `${EVENTBRITE_API}/organizations/${env.EVENTBRITE_ORG_ID}/events/` +
    `?expand=venue&page_size=${fetchSize}` +
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

  const now = new Date();
  const rawEvents = (data.events || [])
    .filter((evt) => evt.listed !== false && evt.invite_only !== true)
    .filter((evt) => !organizerId || evt.organizer_id === organizerId);
  const events: EventItem[] = rawEvents
    .map((evt) => ({
      name: evt.name?.text || evt.name?.html || "Untitled",
      url: evt.url,
      start: evt.start,
      end: evt.end,
      is_free: evt.is_free,
      online_event: evt.online_event,
      summary: evt.summary || evt.description?.text?.substring(0, 300) || "",
      logo_url: uncroppedImageUrl(evt.logo?.original?.url || evt.logo?.url),
      venue: evt.venue
        ? {
            name: evt.venue.name,
            city: evt.venue.address?.city || "",
            address: evt.venue.address?.localized_address_display || "",
          }
        : null,
    }))
    .filter((evt) => {
      const startTime = evt.start?.utc;
      return !startTime || new Date(startTime) > now;
    })
    .slice(0, pageSize);

  const response: EventsResponse = {
    events,
    total: events.length,
  };

  return jsonResponse(response, 200, {
    "Cache-Control": `public, max-age=${cacheTTL}`,
  });
}

// ---------------------------------------------------------------------------
// Widget HTML
// ---------------------------------------------------------------------------

/**
 * Returns the embeddable events widget as a full HTML page.
 * Configurable via query params: `max`, `images`, `descriptions`, `layout`.
 */
function widgetResponse(url: URL, organizerId: string | null): Response {
  const maxEvents = Math.min(
    parseInt(url.searchParams.get("max") || "20", 10),
    50,
  );
  const showImages = url.searchParams.get("images") !== "false";
  const showDescriptions = url.searchParams.get("descriptions") !== "false";
  const layout = url.searchParams.get("layout") === "grid" ? "grid" : "list";

  const html = widgetHTML(maxEvents, showImages, showDescriptions, organizerId, layout);
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

/** Generates the full HTML page for the widget. */
function widgetHTML(
  maxEvents: number,
  showImages: boolean,
  showDescriptions: boolean,
  organizerId: string | null,
  layout: "list" | "grid",
): string {
  // The esc() function inside the <script> sanitizes all Eventbrite data
  // before DOM insertion, preventing XSS from upstream API responses.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SVBC Events</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    --svbc-accent: #FCB315;
    --svbc-accent-light: #FEF3D6;
    --svbc-dark: #2C2C2C;
    --svbc-dark-hover: #1a1a1a;
    --svbc-text: #2C2C2C;
    --svbc-text-muted: #6b7280;
    --svbc-border: #e5e7eb;
    --svbc-radius: 10px;

    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--svbc-text);
    background: transparent;
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem;
  }

  .svbc-loading {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--svbc-text-muted);
    font-size: 0.95rem;
  }

  .svbc-loading-spinner {
    display: inline-block;
    width: 28px;
    height: 28px;
    border: 3px solid var(--svbc-border);
    border-top-color: var(--svbc-accent);
    border-radius: 50%;
    animation: svbc-spin 0.7s linear infinite;
    margin-bottom: 0.75rem;
  }

  @keyframes svbc-spin { to { transform: rotate(360deg); } }

  .svbc-error {
    text-align: center;
    padding: 2rem 1rem;
    color: #b91c1c;
    background: #fef2f2;
    border-radius: var(--svbc-radius);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .svbc-empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--svbc-text-muted);
    font-size: 0.95rem;
  }

  .svbc-event {
    border: 1px solid var(--svbc-border);
    border-radius: var(--svbc-radius);
    overflow: hidden;
    margin-bottom: 1.5rem;
    background: #fff;
  }

  .svbc-event-header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
  }

  .svbc-date-badge {
    flex-shrink: 0;
    width: 54px;
    text-align: center;
    background: var(--svbc-accent);
    border-radius: 8px;
    padding: 6px 0 8px;
  }

  .svbc-date-day {
    display: block;
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1;
    color: var(--svbc-text);
  }

  .svbc-date-month {
    display: block;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--svbc-dark);
    margin-top: 2px;
  }

  .svbc-event-details { flex: 1; min-width: 0; }

  .svbc-event-title {
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 0.6rem;
    color: var(--svbc-text);
  }

  .svbc-meta-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
    color: var(--svbc-text-muted);
    line-height: 1.4;
    margin-bottom: 0.3rem;
  }

  .svbc-meta-row:last-child { margin-bottom: 0; }

  .svbc-meta-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: var(--svbc-accent);
  }

  .svbc-event-img {
    width: 100%;
    background: var(--svbc-accent-light);
  }

  .svbc-event-img img {
    width: 100%;
    height: auto;
    display: block;
  }

  .svbc-event-body {
    padding: 1.25rem 1.5rem;
  }

  .svbc-event-summary {
    font-size: 0.9rem;
    color: var(--svbc-text-muted);
    line-height: 1.6;
    margin-bottom: 1.25rem;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .svbc-cta {
    display: inline-block;
    background: var(--svbc-dark);
    color: #fff;
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 600;
    padding: 0.6rem 1.5rem;
    border-radius: 6px;
    transition: background 0.15s ease;
  }

  .svbc-cta:hover { background: var(--svbc-dark-hover); }

  .svbc-badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    border-radius: 4px;
    margin-left: 0.5rem;
    vertical-align: middle;
  }

  .svbc-badge-free { background: var(--svbc-accent-light); color: var(--svbc-dark); }
  .svbc-badge-paid { background: #fef3c7; color: #92400e; }

  /* Grid layout */
  .svbc-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.5rem;
  }

  @media (max-width: 768px) {
    .svbc-grid { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 480px) {
    .svbc-grid { grid-template-columns: 1fr; }
  }

  .svbc-grid .svbc-event {
    margin-bottom: 0;
    display: flex;
    flex-direction: column;
  }

  .svbc-grid .svbc-event-img {
    position: relative;
    height: 180px;
  }

  .svbc-grid .svbc-event-img img {
    height: 100%;
    object-fit: cover;
  }

  .svbc-grid .svbc-event-header {
    padding: 1rem 1.25rem;
  }

  .svbc-grid .svbc-date-badge {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 1;
    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  }

  .svbc-grid .svbc-event-details { min-width: 0; }

  .svbc-grid .svbc-event-title {
    font-size: 1.05rem;
    margin-bottom: 0.5rem;
  }

  .svbc-grid .svbc-meta-row { font-size: 0.82rem; }

  .svbc-grid .svbc-event-body {
    padding: 0.75rem 1.25rem 1.25rem;
    margin-top: auto;
  }

  .svbc-grid .svbc-event-summary {
    font-size: 0.85rem;
    -webkit-line-clamp: 4;
    margin-bottom: 1rem;
  }

  body:has(.svbc-grid) { max-width: 1100px; }
</style>
</head>
<body>
<div id="svbc-events"></div>
<script>
(function() {
  var SHOW_IMAGE = ${showImages};
  var SHOW_DESCRIPTION = ${showDescriptions};
  var MAX_EVENTS = ${maxEvents};
  var LAYOUT = "${layout}";

  var SVG_CALENDAR = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
  var SVG_CLOCK = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>';
  var SVG_PIN = '<svg class="svbc-meta-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5A4.25 4.25 0 0 0 3.75 5.75C3.75 9.25 8 14.5 8 14.5s4.25-5.25 4.25-8.75A4.25 4.25 0 0 0 8 1.5Z"/><circle cx="8" cy="5.75" r="1.5"/></svg>';

  var container = document.getElementById("svbc-events");
  container.innerHTML =
    '<div class="svbc-loading">' +
      '<div class="svbc-loading-spinner"></div>' +
      '<div>Loading events\\u2026</div>' +
    '</div>';

  fetch("./events?page_size=" + MAX_EVENTS + "${organizerId ? `&organizer=${organizerId}` : ""}")
    .then(function(res) {
      if (!res.ok) throw new Error("Worker returned " + res.status);
      return res.json();
    })
    .then(function(data) {
      var now = new Date();
      var events = (data.events || []).filter(function(evt) {
        return new Date(evt.start.utc) > now;
      });
      if (events.length === 0) {
        container.innerHTML =
          '<div class="svbc-empty">No upcoming events right now \\u2014 check back soon!</div>';
        return;
      }

      if (LAYOUT === "grid") container.className = "svbc-grid";

      var html = "";
      events.forEach(function(evt) {
        var start = new Date(evt.start.local);
        var end = evt.end ? new Date(evt.end.local) : null;
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var fullMonths = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        var fullDays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        var month = months[start.getMonth()];
        var day = start.getDate();

        var dateStr = fullDays[start.getDay()] + ", " + fullMonths[start.getMonth()] + " " + day + ", " + start.getFullYear();

        var timeStr = fmtTime(start);
        if (end) timeStr += "-" + fmtTime(end);

        var locationStr = "";
        if (evt.venue && evt.venue.name) {
          locationStr = esc(evt.venue.name);
          if (evt.venue.address) locationStr += " | " + esc(evt.venue.address);
        } else if (evt.online_event) {
          locationStr = "Online Event";
        }

        var badgeHtml = evt.is_free
          ? '<span class="svbc-badge svbc-badge-free">Free</span>'
          : '<span class="svbc-badge svbc-badge-paid">Tickets</span>';

        var imgHtml = "";
        if (SHOW_IMAGE && evt.logo_url) {
          imgHtml =
            '<div class="svbc-event-img">' +
              '<img src="' + evt.logo_url + '" alt="" loading="lazy">' +
            '</div>';
        }

        var bodyParts = "";
        if (SHOW_DESCRIPTION && evt.summary) {
          bodyParts += '<div class="svbc-event-summary">' + esc(evt.summary) + '</div>';
        }
        bodyParts += '<a class="svbc-cta" href="' + evt.url + '" target="_blank" rel="noopener">More Information</a>';

        var dateBadge =
          '<div class="svbc-date-badge">' +
            '<span class="svbc-date-day">' + day + '</span>' +
            '<span class="svbc-date-month">' + month + '</span>' +
          '</div>';

        if (LAYOUT === "grid") {
          // Grid card: image with overlaid date badge, then details below
          var imgWithBadge = '<div class="svbc-event-img">' + dateBadge;
          if (SHOW_IMAGE && evt.logo_url) {
            imgWithBadge += '<img src="' + evt.logo_url + '" alt="" loading="lazy">';
          }
          imgWithBadge += '</div>';

          html +=
            '<div class="svbc-event">' +
              imgWithBadge +
              '<div class="svbc-event-header">' +
                '<div class="svbc-event-details">' +
                  '<div class="svbc-event-title">' + esc(evt.name) + '</div>' +
                  '<div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div>' +
                  '<div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' +
                  (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') +
                '</div>' +
              '</div>' +
              '<div class="svbc-event-body">' + bodyParts + '</div>' +
            '</div>';
        } else {
          // List card: header with badge + details, then full-width image, then body
          html +=
            '<div class="svbc-event">' +
              '<div class="svbc-event-header">' +
                dateBadge +
                '<div class="svbc-event-details">' +
                  '<div class="svbc-event-title">' + esc(evt.name) + badgeHtml + '</div>' +
                  '<div class="svbc-meta-row">' + SVG_CALENDAR + '<span>' + esc(dateStr) + '</span></div>' +
                  '<div class="svbc-meta-row">' + SVG_CLOCK + '<span>' + esc(timeStr) + '</span></div>' +
                  (locationStr ? '<div class="svbc-meta-row">' + SVG_PIN + '<span>' + locationStr + '</span></div>' : '') +
                '</div>' +
              '</div>' +
              imgHtml +
              '<div class="svbc-event-body">' + bodyParts + '</div>' +
            '</div>';
        }
      });

      container.innerHTML = html;
    })
    .catch(function(err) {
      console.error("SVBC Events Widget Error:", err);
      container.innerHTML =
        '<div class="svbc-error">' +
          "<strong>Couldn't load events.</strong><br>" +
          "Check the browser console for details." +
        '</div>';
    });

  function fmtTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + ampm;
  }

  function esc(str) {
    if (!str) return "";
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
})();
<\/script>
<script>
(function(){
  function postHeight(){
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({svbcEventsHeight: h}, "*");
  }
  new ResizeObserver(postHeight).observe(document.body);
  postHeight();
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips server-side cropping/resizing params from an Eventbrite image URL
 * so the full uncropped image is returned. Keeps quality and format params.
 */
function uncroppedImageUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key === "auto" || key === "q" || key === "sharp" || key === "s") {
        continue;
      }
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

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

  if (origin === "") {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, { status: response.status, headers });
}
