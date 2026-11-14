# SVBC Events Worker

A Cloudflare Worker that proxies the Eventbrite API v3, keeping the private OAuth token server-side, and serves an embeddable HTML events widget. Responses are edge-cached via the Cloudflare Cache API with a configurable TTL.

Written in TypeScript using `@cloudflare/workers-types`. Wrangler handles transpilation — no separate build step. Lives in a single file: `src/worker.ts`.

## Routes

### `GET /` and `GET /events`

Returns upcoming events as JSON.

- Fetches from `GET /v3/organizations/{EVENTBRITE_ORG_ID}/events/?expand=venue&status=live&order_by=start_asc` using the private `EVENTBRITE_TOKEN`.
- Filters out events whose start time is in the past.
- When an `organizer` query param is provided, filters events to that organizer ID. The ID must be in the `ALLOWED_ORGANIZERS` allowlist or the request is rejected with 400.
- Query params: `page_size` (default 20, max 50), `organizer` (optional).
- Returns `{ events: EventItem[], total: number }`.

Each `EventItem` contains: `name`, `url`, `start`, `end`, `is_free`, `online_event`, `summary`, `logo_url` (uncropped), and `venue` (name, city, address) or null.

### `GET /widget`

Returns a self-contained HTML page designed to be loaded in an iframe. The page fetches from the sibling `/events` endpoint client-side and renders event cards.

- Query params: `max` (default 20, max 50), `images` (default true), `descriptions` (default true), `organizer` (optional), `layout` (`list` or `grid`, default `list`).
- All Eventbrite data is HTML-escaped before DOM insertion to prevent XSS.
- Uses a `ResizeObserver` to `postMessage` its `scrollHeight` to the parent window so the embedding page can auto-resize the iframe.

### `OPTIONS *`

Returns CORS preflight headers. All other methods return 405.

### Everything else

Returns 404 JSON: `{ error: "Not found. Use /events or /widget" }`.

## Caching

Uses `caches.default` (Cloudflare Cache API), not `Cache-Control` from the browser.

- Cache keys are normalized by `page_size`, `organizer`, and `CACHE_VERSION` to avoid origin-based fragmentation.
- On a HIT, the response is served from the edge with `X-Cache: HIT`.
- On a MISS, the worker fetches from Eventbrite, responds immediately, and writes to cache in the background via `ctx.waitUntil`.
- `CACHE_VERSION` in `wrangler.toml` can be bumped to bust stale cache entries on deploy.

## CORS

The `handleCORS` function sets `Access-Control-Allow-Origin: *` on every response. Every route is public, read-only data, and responses are edge-cached without `Vary: Origin`, so reflecting the request's `Origin` would serve one site's header to another (#72).

## Environment Bindings

Declared in `wrangler.toml` `[vars]`:

- `EVENTBRITE_ORG_ID` — Eventbrite organization ID.
- `CACHE_TTL` — Edge cache lifetime in seconds.
- `CACHE_VERSION` — Bump to invalidate cache.

Secret (set via `wrangler secret put`):

- `EVENTBRITE_TOKEN` — Eventbrite private OAuth token. Never stored in code.

## Widget Design

### List layout (default)

Vertical stack of cards. Each card has a header row (date badge + title/metadata), an optional full-width image, and a body (summary + "More Information" CTA).

### Grid layout

Responsive 3-column grid (2 columns below 768px, 1 column below 480px). Date badge overlays the image. `max-width` widens to 1100px.

### Styling

CSS custom properties on `body`:

- `--svbc-accent: #FFC700` (SVBC gold, as bikesiliconvalley.org)
- `--svbc-dark` / `--svbc-text: #303030` (website ink)
- `--svbc-radius: 10px`

The "More Information" link is the website's primary button: a gold pill (300px radius) with black
Poppins 16px text. Manrope (event titles) and Poppins (everything else) are self-hosted by this
Worker at `/fonts/*.woff2` (`src/fonts.ts`, #123), since the iframe doesn't inherit the parent
page's fonts and loading them from Google Fonts would send each visitor's IP address to Google;
the system stack is the fallback. No external stylesheets or dependencies.

## Embedding

The parent page should include an iframe and a `message` event listener:

```html
<iframe
  id="svbc-events"
  src="https://events.bikesiliconvalley.org/widget?organizer=21763925459"
  style="width:100%;border:none;min-height:800px;overflow:hidden"
  loading="lazy"
  title="SVBC Upcoming Events"
></iframe>
<script>
window.addEventListener("message", function(e) {
  if (e.data && e.data.svbcEventsHeight) {
    document.getElementById("svbc-events").style.height = e.data.svbcEventsHeight + "px";
  }
});
</script>
```
