import type { Env, NormalizedEvent } from './types';
import { fetchEventbriteEvents } from './adapters/eventbrite';
import rawOrganizers from '../config/eventbriteOrganizers.json';
import { errorMessage } from './util/errorMessage';

interface EventbriteOrganizerConfig {
  id: string;
  label: string;
}

function validateOrganizers(raw: unknown): EventbriteOrganizerConfig[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Record<string, unknown>).organizers)) {
    throw new Error('config/eventbriteOrganizers.json: missing required key "organizers" (array)');
  }
  return (raw as { organizers: unknown[] }).organizers.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`config/eventbriteOrganizers.json: organizers[${index}] must be an object`);
    }
    const { id, label } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') {
      throw new Error(`config/eventbriteOrganizers.json: organizers[${index}].id must be a non-empty string`);
    }
    if (typeof label !== 'string' || label === '') {
      throw new Error(`config/eventbriteOrganizers.json: organizers[${index}].label must be a non-empty string`);
    }
    return { id, label };
  });
}

/**
 * Eventbrite organizer IDs allowed via the `organizer` query param, derived from
 * config/eventbriteOrganizers.json rather than hardcoded here. Two of these three ids are also
 * the `organizerId` of an Eventbrite source in config/sources.json (those two have their own ICS
 * calendar feed); the third — "bike parking" — has no ICS feed of its own and exists only in this
 * organizers list. Kept as its own small config file, rather than folded entirely into
 * sources.json, to avoid turning "bike parking" into a 10th public calendar feed + listing entry
 * for a change that's purely about not hardcoding organizer ids in source.
 */
export const ALLOWED_ORGANIZERS: string[] = validateOrganizers(rawOrganizers).map((o) => o.id);

interface EventVenue {
  name: string;
  city: string;
  address: string;
}

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

interface EventsResponse {
  events: EventItem[];
  total: number;
}

/** Deliberately just a generic message: the upstream detail is logged, never returned publicly (#72). */
interface ErrorResponse {
  error: string;
}

function jsonResponse(body: EventsResponse | ErrorResponse, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

function toEventItem(event: NormalizedEvent): EventItem {
  return {
    name: event.title,
    url: event.url ?? '',
    start: { timezone: event.timezone ?? '', local: event.startLocal ?? '', utc: event.startUtc },
    end: { timezone: event.timezone ?? '', local: event.endLocal ?? '', utc: event.endUtc ?? event.startUtc },
    is_free: event.isFree ?? false,
    online_event: event.onlineEvent ?? false,
    summary: event.summary || event.description?.slice(0, 300) || '',
    logo_url: event.logoUrl ?? null,
    venue: event.venueName ? { name: event.venueName, city: event.venueCity ?? '', address: event.venueAddress ?? '' } : null,
  };
}

/** An ad-hoc EventbriteSourceConfig for organizer-scoped widget fetches (these aren't calendar sources with their own .ics feed — bike parking in particular has none). */
function organizerSource(organizerId: string) {
  return { id: organizerId, name: organizerId, committeeName: '', adapter: 'eventbrite' as const, organizerId };
}

async function fetchOrganizerEvents(organizerId: string, token: string): Promise<NormalizedEvent[]> {
  return fetchEventbriteEvents(organizerSource(organizerId), token, 50);
}

export async function fetchEventsResponse(env: Env, organizerId: string | null, pageSize: number, cacheTTL: number): Promise<Response> {
  let events: NormalizedEvent[];
  // True when the merged feed is missing an organizer that failed: still served, never cached.
  let partial = false;
  if (organizerId) {
    try {
      events = await fetchOrganizerEvents(organizerId, env.EVENTBRITE_TOKEN);
    } catch (err) {
      console.error(`svbc-calendars: /events failed for organizer ${organizerId}: ${errorMessage(err)}`);
      return jsonResponse({ error: 'Eventbrite API error' }, 502);
    }
  } else {
    // One organizer failing — e.g. deleted on Eventbrite, as "bike parking" (121346572357) was by
    // 2026-09-30 — must not blank the whole widget: serve the organizers that answered and log the
    // rest. Only when every organizer fails is the feed an error.
    const settled = await Promise.allSettled(ALLOWED_ORGANIZERS.map((id) => fetchOrganizerEvents(id, env.EVENTBRITE_TOKEN)));
    const failures = settled.flatMap((result, i) =>
      result.status === 'rejected' ? [`organizer ${ALLOWED_ORGANIZERS[i]}: ${errorMessage(result.reason)}`] : []);
    if (failures.length === settled.length) {
      console.error(`svbc-calendars: /events failed for every organizer: ${failures.join('; ')}`);
      return jsonResponse({ error: 'Eventbrite API error' }, 502);
    }
    for (const failure of failures) {
      console.error(`svbc-calendars: /events served without ${failure}`);
    }
    partial = failures.length > 0;
    events = settled
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  }

  const now = new Date();
  const items = events
    .filter((evt) => new Date(evt.startUtc) > now)
    .slice(0, pageSize)
    .map(toEventItem);

  // A partial feed is marked no-store so withCache (index.ts) doesn't pin it for the full TTL: a
  // transient failure of the main organizer would otherwise hide its events for 15 minutes.
  const cacheControl = partial ? 'no-store' : `public, max-age=${cacheTTL}`;
  return jsonResponse({ events: items, total: items.length }, 200, { 'Cache-Control': cacheControl });
}
