import type { EventbriteSourceConfig, NormalizedEvent } from '../types';
import { toValidUrl } from '../util/toValidUrl';

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

function organizerEventsUrl(organizerId: string, continuation?: string): string {
  const base = `https://www.eventbriteapi.com/v3/organizers/${organizerId}/events/?expand=venue&status=live&order_by=start_asc&time_filter=current_future`;
  return continuation ? `${base}&continuation=${encodeURIComponent(continuation)}` : base;
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

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`eventbrite: organizer ${source.organizerId} fetch failed: ${response.status} ${response.statusText}`);
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
