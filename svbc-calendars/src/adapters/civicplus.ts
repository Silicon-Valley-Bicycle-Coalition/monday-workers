import type { CivicPlusSourceConfig, NormalizedEvent } from '../types';
import { parseIcsEvents } from '../util/parseIcs';
import { toValidUrl } from '../util/toValidUrl';
import { SOURCE_FETCH_TIMEOUT_MS } from '../util/fetchTimeout';

export async function fetchCivicPlusEvents(source: CivicPlusSourceConfig): Promise<NormalizedEvent[]> {
  const url = `https://${source.domain}/common/modules/iCalendar/iCalendar.aspx?catID=${source.catId}&feed=calendar`;
  const response = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`civicplus: ${source.domain} catID=${source.catId} fetch failed: ${response.status} ${response.statusText}`);
  }
  const icsText = await response.text();

  return parseIcsEvents(icsText).map((parsed) => ({
    sourceId: source.id,
    externalId: parsed.uid,
    title: parsed.summary,
    committeeName: source.committeeName,
    startUtc: parsed.startUtc,
    endUtc: parsed.endUtc,
    location: parsed.location,
    url: toValidUrl(parsed.url),
  }));
}
