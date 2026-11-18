import type { EventbriteSourceConfig, NormalizedEvent } from '../types';
import { toValidUrl } from '../util/toValidUrl';
import { SOURCE_FETCH_TIMEOUT_MS } from '../util/fetchTimeout';

interface EventbriteEventRecord {
  id: string;
  name: { text: string; html?: string };
  description?: { text: string | null } | null;
  summary?: string | null;
  url: string;
  is_free: boolean;
  online_event: boolean;
  logo?: { url?: string; original?: { url?: string } } | null;
  start: { timezone: string; local: string; utc: string };
  end: { timezone: string; local: string; utc: string };
  venue?: { name?: string | null; address?: { city?: string | null; localized_address_display?: string | null } | null } | null;
  listed?: boolean;
  invite_only?: boolean;
}

interface EventbriteEventsResponse {
  events: EventbriteEventRecord[];
  pagination: { has_more_items: boolean; continuation?: string };
}

const MAX_PAGES = 20;

// No `time_filter`: since 2026-09-23 Eventbrite rejects it on this endpoint
// ("time_filter - Unknown parameter", 400). `status=live` already excludes
// events that have started or ended, which have statuses of their own.
function organizerEventsUrl(organizerId: string, continuation?: string): string {
  const base = `https://www.eventbriteapi.com/v3/organizers/${organizerId}/events/?expand=venue&status=live&order_by=start_asc`;
  return continuation ? `${base}&continuation=${encodeURIComponent(continuation)}` : base;
}

const MAX_ERROR_DETAIL = 300;

/**
 * Eventbrite names the bad argument or auth problem in its error body
 * (`{"error": "ARGUMENTS_ERROR", "error_description": "..."}`), which the
 * status line alone doesn't. Since GL#72 the message no longer reaches
 * status.json or the /events response; a non-JSON body (an HTML error page) is capped.
 */
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === 'string' || typeof body.error_description === 'string') {
      return [body.error, body.error_description].filter((part) => typeof part === 'string' && part).join(': ');
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Strips server-side cropping/resizing params from an Eventbrite image URL
 * so the full uncropped image is returned. Keeps quality and format params.
 */
function uncroppedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (key === 'auto' || key === 'q' || key === 'sharp' || key === 's') {
        continue;
      }
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function toNormalizedEvent(record: EventbriteEventRecord, source: EventbriteSourceConfig): NormalizedEvent {
  return {
    sourceId: source.id,
    externalId: record.id,
    title: record.name.text || (record.name.html ? stripHtml(record.name.html) : '') || 'Untitled',
    committeeName: source.committeeName,
    startUtc: record.start.utc,
    endUtc: record.end.utc,
    location: record.venue?.address?.localized_address_display ?? null,
    url: toValidUrl(record.url),
    description: record.description?.text ?? null,
    startLocal: record.start.local,
    endLocal: record.end.local,
    timezone: record.start.timezone,
    isFree: record.is_free,
    onlineEvent: record.online_event,
    summary: record.summary ?? null,
    logoUrl: uncroppedImageUrl(record.logo?.original?.url ?? record.logo?.url ?? null),
    venueName: record.venue?.name ?? null,
    venueCity: record.venue?.address?.city ?? null,
    venueAddress: record.venue?.address?.localized_address_display ?? null,
  };
}

export async function fetchEventbriteEvents(source: EventbriteSourceConfig, token: string, maxEvents?: number): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  let url: string | null = organizerEventsUrl(source.organizerId);
  let pageCount = 0;

  while (url) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) {
      console.error(`eventbrite: organizer ${source.organizerId} hit the ${MAX_PAGES}-page cap; stopping and returning what's been collected so far`);
      break;
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new Error(`eventbrite: organizer ${source.organizerId} fetch failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
    }
    const body = (await response.json()) as EventbriteEventsResponse;

    for (const record of body.events) {
      if (record.listed === false || record.invite_only === true) {
        continue;
      }
      events.push(toNormalizedEvent(record, source));
      if (maxEvents !== undefined && events.length >= maxEvents) {
        return events;
      }
    }

    if (body.pagination.has_more_items && body.pagination.continuation) {
      url = organizerEventsUrl(source.organizerId, body.pagination.continuation);
    } else {
      if (body.pagination.has_more_items) {
        console.error(`eventbrite: organizer ${source.organizerId} reported has_more_items with no continuation token; stopping pagination`);
      }
      url = null;
    }
  }

  return events;
}
