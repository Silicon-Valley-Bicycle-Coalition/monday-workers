import type { LegistarSourceConfig, NormalizedEvent } from '../types';
import { zonedTimeToUtc } from '../util/zonedTime';
import { toValidUrl } from '../util/toValidUrl';
import { SOURCE_FETCH_TIMEOUT_MS } from '../util/fetchTimeout';

interface LegistarEventRecord {
  EventId: number;
  EventDate: string; // e.g. "2026-01-29T00:00:00", naive Pacific-local
  EventTime: string; // e.g. "7:00 PM"
  EventLocation: string | null;
  EventInSiteURL: string | null;
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

function parseEventTime(eventTime: string | null | undefined): { hour: number; minute: number } {
  if (!eventTime || typeof eventTime !== 'string') {
    return { hour: 0, minute: 0 };
  }
  const match = TIME_PATTERN.exec(eventTime.trim());
  if (!match) {
    return { hour: 0, minute: 0 };
  }
  const [, hourStr, minuteStr, meridiem] = match;
  let hour = Number(hourStr) % 12;
  if (meridiem?.toUpperCase() === 'PM') {
    hour += 12;
  }
  return { hour, minute: Number(minuteStr) };
}

function parseEventDate(eventDate: string, eventId: number): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(eventDate);
  if (!match) {
    throw new Error(`legistar: unparseable EventDate "${eventDate}" for event ${eventId}`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

export async function fetchLegistarEvents(source: LegistarSourceConfig, now: Date): Promise<NormalizedEvent[]> {
  const isoDate = now.toISOString().slice(0, 10);
  const filter = `EventBodyId eq ${source.bodyId} and EventDate ge datetime'${isoDate}'`;
  const url = `https://webapi.legistar.com/v1/${source.client}/events?${encodeURIComponent('$filter')}=${encodeURIComponent(filter)}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`legistar: ${source.client} events fetch failed: ${response.status} ${response.statusText}`);
  }
  const records = (await response.json()) as LegistarEventRecord[];

  return records.map((record) => {
    const { year, month, day } = parseEventDate(record.EventDate, record.EventId);
    const { hour, minute } = parseEventTime(record.EventTime);
    const startUtc = zonedTimeToUtc(year, month, day, hour, minute, 'America/Los_Angeles');
    return {
      sourceId: source.id,
      externalId: String(record.EventId),
      title: source.committeeName,
      committeeName: source.committeeName,
      startUtc: startUtc.toISOString(),
      endUtc: null,
      location: record.EventLocation,
      url: toValidUrl(record.EventInSiteURL),
    };
  });
}
