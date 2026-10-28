import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { createFetchSourceEvents } from './adapters/dispatch';
import { fetchEventsResponse, ALLOWED_ORGANIZERS } from './eventsApi';
import { widgetResponse } from './widget';
import { getSourceCalendar } from './calendarSource';
import { buildListing, buildListingHtml } from './listing';
import { getAllSourceStatuses } from './calendarStore';
import { sendFailureAlert } from './alert';
import { recordMetric } from './metrics';
import { errorMessage } from './util/errorMessage';
import { checkRequestRateLimit } from './rateLimit';
import type { Env } from './types';

const config = validateConfig(rawConfig);

// The listing page is served from committees.bikesiliconvalley.org, but this Worker also answers
// on events.bikesiliconvalley.org — hardcode the canonical domain for subscribe links rather than
// reflecting whatever host the request came in on, since staff paste these links into permanent
// places (calendar apps, emails, web pages) where a wrong-domain link would silently stick around.
const CALENDAR_DOMAIN = 'https://committees.bikesiliconvalley.org';

// Routes served through withCache — see the rate-limit comment in fetch() for why these are
// limited only on a cache MISS.
const CACHED_PATHS = new Set(['/', '/events', '/calendars']);
const ICS_PATH = /^\/calendars\/([a-z0-9-]+)\.ics$/;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * `page_size` for /events, clamped to 1..MAX_PAGE_SIZE. Anything missing or non-numeric
 * (`abc`, `NaN`) falls back to the default rather than flowing through as NaN — `slice(0, NaN)`
 * is an empty list, which would then be cached as a valid 200 under its own cache key.
 */
function parsePageSize(raw: string | null): number {
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(parsed, 1), MAX_PAGE_SIZE);
}

/**
 * Every route is public, unauthenticated, read-only data, so CORS is a plain `*`. An origin
 * allowlist bought nothing here: it fell back to `*` for any other origin anyway, and reflecting
 * the request's Origin into responses stored in caches.default without `Vary: Origin` would serve
 * one site's reflected header to the next. (#72)
 */
function handleCORS(_request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Cache-aside wrapper shared by every cached route: serve caches.default on a HIT (tagging
 * X-Cache: HIT); on a MISS, call `generate`, tag X-Cache: MISS, and — only for a successful
 * (`ok`) response — write it to the cache in the background via ctx.waitUntil so the response
 * isn't delayed by the cache write. A non-ok response (404, 503) is deliberately never cached,
 * so the next request retries live instead of serving a cached failure for the full TTL.
 */
async function withCache(cacheKey: Request, ttlSeconds: number, ctx: ExecutionContext, generate: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set('X-Cache', 'HIT');
    return response;
  }
  const fresh = await generate();
  const response = new Response(fresh.body, fresh);
  response.headers.set('X-Cache', 'MISS');
  // A generator marks a successful-but-incomplete response no-store (eventsApi.ts's partial
  // multi-organizer feed): serve it, but don't pin it for the TTL.
  const noStore = /\bno-store\b/i.test(fresh.headers.get('Cache-Control') ?? '');
  if (fresh.ok && !noStore) {
    // Set on the response returned to THIS caller too, not just the cached copy — otherwise a
    // MISS response has no Cache-Control while the HIT response served from `cached` on the next
    // request does (it was stored with one), which is an inconsistent, confusing mismatch for
    // any downstream cache/browser respecting standard HTTP caching headers.
    response.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

async function handleCalendarIcs(sourceId: string, env: Env): Promise<Response> {
  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) {
    // Deliberately a constant sentinel, not the raw (attacker-controlled) sourceId: a 404 here is
    // never cached (withCache only caches `ok` responses), so a crawler hammering
    // /calendars/<random-string>.ics in a loop would otherwise blow up the Analytics Engine
    // index's cardinality with one unique index value per request.
    recordMetric(env, { route: 'calendars.ics', sourceId: 'unknown', outcome: 'error' });
    return new Response('Not found', { status: 404 });
  }
  const result = await getSourceCalendar(source, {
    kv: env.CALENDAR_KV,
    fetchSourceEvents: createFetchSourceEvents(env.EVENTBRITE_TOKEN),
    sendFailureAlert,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    now: () => new Date(),
  });
  recordMetric(env, { route: 'calendars.ics', sourceId, outcome: result.ics === null ? 'error' : result.servedFromFallback ? 'fallback' : 'live' });
  if (result.ics === null) {
    return new Response('This calendar has never successfully synced and has no cached fallback.', { status: 503 });
  }
  return new Response(result.ics, {
    status: 200,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'X-Served-From': result.servedFromFallback ? 'fallback' : 'live' },
  });
}

async function handleCalendarListing(env: Env): Promise<Response> {
  const listing = buildListing(config, CALENDAR_DOMAIN);
  const html = buildListingHtml(listing, env.CF_WEB_ANALYTICS_TOKEN ?? '');
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// /status.json is deliberately never cached (no withCache wrapping) — its whole purpose is
// reflecting current per-source health, and caching it for the same ~24h TTL as the calendar
// routes would hide a fresh failure from anyone checking it for up to a day.
// lastError is left out: it's raw upstream error text (URLs, response bodies), which stays in KV,
// the Worker logs and the Slack alert rather than on a public endpoint (#72).
async function handleStatus(env: Env): Promise<Response> {
  const statuses = await getAllSourceStatuses(env.CALENDAR_KV, config.sources.map((s) => s.id));
  const publicStatuses = Object.fromEntries(
    Object.entries(statuses).map(([id, { consecutiveFailures, lastSuccessAt }]) => [id, { consecutiveFailures, lastSuccessAt }])
  );
  return new Response(JSON.stringify(publicStatuses, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        return handleCORS(request, new Response(null, { status: 204 }));
      }

      const url = new URL(request.url);
      const organizerId = url.searchParams.get('organizer');
      const organizerAllowed = !organizerId || ALLOWED_ORGANIZERS.includes(organizerId);
      const version = env.CACHE_VERSION || '0';
      const icsMatch = ICS_PATH.exec(url.pathname);

      // Per-IP limit — see README "Reliability: traffic and cost limits". REQUEST_RATE_LIMITER is
      // provisioned in wrangler.jsonc. A cacheable route checks it only on a cache MISS (inside
      // withCache's `generate`), so a cache HIT is never limited: calendar-subscription services
      // (Google, Apple, Outlook) poll every .ics feed from a handful of shared IPs, and throttling
      // them on responses that cost nothing to serve would just break subscriptions. Every
      // uncached request — any MISS, and every non-cacheable route — is still limited before any
      // upstream fetch or KV work.
      const limiter = { limit: (key: string) => env.REQUEST_RATE_LIMITER.limit({ key }) };
      const limitedOr = async (generate: () => Promise<Response>): Promise<Response> =>
        (await checkRequestRateLimit(request, limiter)) ?? generate();
      const cacheable = request.method === 'GET' && organizerAllowed && (CACHED_PATHS.has(url.pathname) || icsMatch !== null);
      if (!cacheable) {
        const limited = await checkRequestRateLimit(request, limiter);
        if (limited) return handleCORS(request, limited);
      }

      if (request.method !== 'GET') {
        return handleCORS(request, new Response('Method not allowed', { status: 405 }));
      }

      // Preserved from the original worker.ts: an `organizer` param outside the allowlist is
      // rejected outright, for both the JSON API and the widget — never silently ignored or
      // passed through to Eventbrite.
      if (!organizerAllowed) {
        return handleCORS(
          request,
          new Response(JSON.stringify({ error: 'Unknown organizer ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        );
      }

      if (url.pathname === '/widget') {
        return handleCORS(request, widgetResponse(url, organizerId, env.CF_WEB_ANALYTICS_TOKEN ?? ''));
      }
      if (url.pathname === '/' || url.pathname === '/events') {
        const pageSize = parsePageSize(url.searchParams.get('page_size'));
        const cacheTTL = parseInt(env.CACHE_TTL || '900', 10);
        const cacheKey = new Request(`${url.origin}/events?page_size=${pageSize}&organizer=${organizerId || 'all'}&v=${version}`, { method: 'GET' });
        const response = await withCache(cacheKey, cacheTTL, ctx, () => limitedOr(() => fetchEventsResponse(env, organizerId, pageSize, cacheTTL)));
        if (response.headers.get('X-Cache') === 'HIT') {
          recordMetric(env, { route: 'events', sourceId: organizerId || 'all', outcome: 'cache-hit' });
        }
        return handleCORS(request, response);
      }
      if (url.pathname === '/calendars') {
        const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
        const cacheKey = new Request(`${url.origin}/calendars?v=${version}`, { method: 'GET' });
        const response = await withCache(cacheKey, calendarTTL, ctx, () => limitedOr(() => handleCalendarListing(env)));
        if (response.headers.get('X-Cache') === 'HIT') {
          recordMetric(env, { route: 'calendars', sourceId: 'all', outcome: 'cache-hit' });
        }
        return handleCORS(request, response);
      }
      if (icsMatch) {
        const sourceId = icsMatch[1];
        const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
        const cacheKey = new Request(`${url.origin}/calendars/${sourceId}.ics?v=${version}`, { method: 'GET' });
        const response = await withCache(cacheKey, calendarTTL, ctx, () => limitedOr(() => handleCalendarIcs(sourceId, env)));
        if (response.headers.get('X-Cache') === 'HIT') {
          recordMetric(env, { route: 'calendars.ics', sourceId, outcome: 'cache-hit' });
        }
        return handleCORS(request, response);
      }
      if (url.pathname === '/status.json') {
        return handleCORS(request, await handleStatus(env));
      }

      return handleCORS(request, new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    } catch (err) {
      // Belt-and-suspenders equivalent of the original worker.ts's top-level catch: a malformed
      // KV value, a caches.default failure, or anything else unexpected must still come back as a
      // JSON 500 run through handleCORS — not Cloudflare's raw error page, which would bypass CORS
      // entirely and break the widget/listing pages for anyone whose browser enforces it.
      console.error(`svbc-calendars: unhandled error in fetch: ${errorMessage(err)}`);
      return handleCORS(
        request,
        new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const fetchSourceEvents = createFetchSourceEvents(env.EVENTBRITE_TOKEN);
    for (const source of config.sources) {
      await getSourceCalendar(source, {
        kv: env.CALENDAR_KV,
        fetchSourceEvents,
        sendFailureAlert,
        slackWebhookUrl: env.SLACK_WEBHOOK_URL,
        now: () => new Date(),
      });
    }
  },
} satisfies ExportedHandler<Env>;
