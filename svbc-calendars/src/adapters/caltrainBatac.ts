import type { CaltrainBatacSourceConfig, NormalizedEvent } from '../types';
import { parseIcsEvents } from '../util/parseIcs';
import { SOURCE_FETCH_TIMEOUT_MS } from '../util/fetchTimeout';

const DATA_URI_PATTERN = /data:text\/calendar;charset=utf8;base64,([A-Za-z0-9+/=]+)/g;

export async function fetchCaltrainBatacEvents(source: CaltrainBatacSourceConfig): Promise<NormalizedEvent[]> {
  const response = await fetch(source.pageUrl, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`caltrainBatac: page fetch failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();

  const events: NormalizedEvent[] = [];
  for (const match of html.matchAll(DATA_URI_PATTERN)) {
    const base64 = match[1];
    if (!base64) {
      continue;
    }
    const icsText = atob(base64);
    for (const parsed of parseIcsEvents(icsText)) {
      if (!parsed.summary.includes(source.titleFilter)) {
        continue;
      }
      events.push({
        sourceId: source.id,
        externalId: parsed.uid,
        title: parsed.summary,
        committeeName: source.committeeName,
        startUtc: parsed.startUtc,
        endUtc: parsed.endUtc === parsed.startUtc ? null : parsed.endUtc,
        location: parsed.location,
        url: source.pageUrl,
      });
    }
  }
  return events;
}
