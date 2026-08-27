import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { createFetchSourceEvents } from './adapters/dispatch';
import { fetchEventsResponse, ALLOWED_ORGANIZERS } from './eventsApi';
import { widgetResponse } from './widget';
import { getSourceCalendar } from './calendarSource';
import { buildListing, buildListingHtml } from './listing';
import { getAllSourceStatuses } from './calendarStore';
import { sendFailureAlert } from './alert';
import type { Env } from './types';

const config = validateConfig(rawConfig);

const ALLOWED_ORIGINS: string[] = ['https://www.bikesiliconvalley.org', 'https://bikesiliconvalley.org', 'http://localhost'];

function handleCORS(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin') || '';
  const headers = new Headers(response.headers);
  if (origin === '' || !ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else {
    headers.set('Access-Control-Allow-Origin', origin);
  }
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
  if (fresh.ok) {
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
    return new Response('Not found', { status: 404 });
  }
  const result = await getSourceCalendar(source, {
    kv: env.CALENDAR_KV,
    fetchSourceEvents: createFetchSourceEvents(env.EVENTBRITE_TOKEN),
    sendFailureAlert,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    now: () => new Date(),
  });
  if (result.ics === null) {
    return new Response('This calendar has never successfully synced and has no cached fallback.', { status: 503 });
  }
  return new Response(result.ics, {
    status: 200,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'X-Served-From': result.servedFromFallback ? 'fallback' : 'live' },
  });
}

async function handleCalendarListing(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const listing = buildListing(config, url.origin);
  const html = buildListingHtml(listing, env.CF_WEB_ANALYTICS_TOKEN ?? '');
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// /status.json is deliberately never cached (no withCache wrapping) — its whole purpose is
// reflecting current per-source health, and caching it for the same ~24h TTL as the calendar
// routes would hide a fresh failure from anyone checking it for up to a day.
async function handleStatus(env: Env): Promise<Response> {
  const statuses = await getAllSourceStatuses(env.CALENDAR_KV, config.sources.map((s) => s.id));
  return new Response(JSON.stringify(statuses, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleCORS(request, new Response(null, { status: 204 }));
    }
    if (request.method !== 'GET') {
      return handleCORS(request, new Response('Method not allowed', { status: 405 }));
    }

    const url = new URL(request.url);
    const organizerId = url.searchParams.get('organizer');
    const version = env.CACHE_VERSION || '0';

    // Preserved from the original worker.ts: an `organizer` param outside the allowlist is
    // rejected outright, for both the JSON API and the widget — never silently ignored or
    // passed through to Eventbrite.
    if (organizerId && !ALLOWED_ORGANIZERS.includes(organizerId)) {
      return handleCORS(
        request,
        new Response(JSON.stringify({ error: 'Unknown organizer ID' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      );
    }

    if (url.pathname === '/widget') {
      return handleCORS(request, widgetResponse(url, organizerId));
    }
    if (url.pathname === '/' || url.pathname === '/events') {
      const pageSize = Math.min(parseInt(url.searchParams.get('page_size') || '20', 10), 50);
      const cacheTTL = parseInt(env.CACHE_TTL || '900', 10);
      const cacheKey = new Request(`${url.origin}/events?page_size=${pageSize}&organizer=${organizerId || 'all'}&v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, cacheTTL, ctx, () => fetchEventsResponse(env, organizerId, pageSize, cacheTTL)));
    }
    if (url.pathname === '/calendars') {
      const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
      const cacheKey = new Request(`${url.origin}/calendars?v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, calendarTTL, ctx, () => handleCalendarListing(request, env)));
    }
    const icsMatch = /^\/calendars\/([a-z0-9-]+)\.ics$/.exec(url.pathname);
    if (icsMatch) {
      const sourceId = icsMatch[1];
      const calendarTTL = parseInt(env.CALENDAR_CACHE_TTL || '86400', 10);
      const cacheKey = new Request(`${url.origin}/calendars/${sourceId}.ics?v=${version}`, { method: 'GET' });
      return handleCORS(request, await withCache(cacheKey, calendarTTL, ctx, () => handleCalendarIcs(sourceId, env)));
    }
    if (url.pathname === '/status.json') {
      return handleCORS(request, await handleStatus(env));
    }

    return handleCORS(request, new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
