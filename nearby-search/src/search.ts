// The search itself, shared by preview and confirm: resolve the location through OSM, read every
// source board's contacts, and keep the ones within `miles` of the point or road. Pure of D1 and
// the queue so confirm can re-run it server-side and never trust a client-supplied match list.
import type { Config } from './config';
import { filterContacts, type FilterMode } from './geometry';
import { parseLocationText } from './locate/parse';
import type { OsmClient } from './locate/osm';
import { resolveLocation, type Resolved } from './locate/resolve';
import type { NearbyMondayClient } from './monday/client';
import type { ContactKind } from './types';

export interface PreviewRequest {
  query?: string;
  eventItemId?: string;
  miles: number;
}

export interface Preview {
  resolved: Resolved;
  miles: number;
  matches: { id: string; kind: ContactKind; name: string; lat: number; lng: number }[];
  counts: Record<ContactKind, number>;
  skippedNoLocation: Record<ContactKind, number>;
}

export interface SearchDeps {
  osm: OsmClient;
  monday: NearbyMondayClient;
  config: Config;
}

export const MIN_MILES = 0.05;
export const MAX_MILES = 10;

// A request the caller got wrong (as opposed to a location that simply isn't on the map).
export class SearchInputError extends Error {}

const zeroCounts = (): Record<ContactKind, number> => ({ person: 0, historical: 0, organization: 0 });

// Returns the first problem with a request body, or null. Applied before any network work.
export function validatePreviewRequest(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return 'Request body must be a JSON object.';
  const { query, eventItemId, miles } = req as Record<string, unknown>;
  const hasQuery = query !== undefined && query !== null && query !== '';
  const hasEvent = eventItemId !== undefined && eventItemId !== null && eventItemId !== '';
  if (hasQuery === hasEvent) return 'Provide exactly one of query or eventItemId.';
  if (hasQuery && typeof query !== 'string') return 'query must be a string.';
  if (hasEvent && typeof eventItemId !== 'string') return 'eventItemId must be a string.';
  if (typeof miles !== 'number' || !Number.isFinite(miles) || miles < MIN_MILES || miles > MAX_MILES) {
    return `miles must be a number from ${MIN_MILES} to ${MAX_MILES}.`;
  }
  return null;
}

export async function runSearch(req: PreviewRequest, deps: SearchDeps): Promise<Preview> {
  const { osm, monday, config } = deps;
  const empty = (resolved: Resolved): Preview => ({
    resolved,
    miles: req.miles,
    matches: [],
    counts: zeroCounts(),
    skippedNoLocation: zeroCounts(),
  });

  let resolved: Resolved;
  if (req.eventItemId) {
    const event = await monday.getEventAddress(config.monday.eventsBoardId, req.eventItemId, config.monday.eventsAddressColumn);
    if (!event) return empty({ kind: 'not-found', message: 'Event not found or has no address.' });
    resolved = await resolveLocation({ kind: 'address', text: event.address }, osm, config.serviceArea);
  } else {
    const parsed = parseLocationText(req.query ?? '');
    if (parsed.kind === 'empty') throw new SearchInputError('query is empty.');
    resolved = await resolveLocation(parsed, osm, config.serviceArea);
  }
  if (resolved.kind === 'not-found') return empty(resolved);

  const mode: FilterMode =
    resolved.kind === 'point'
      ? { kind: 'radius', center: { lat: resolved.lat, lng: resolved.lng }, radiusMiles: req.miles }
      : { kind: 'corridor', geometry: resolved.geometry, bufferMiles: req.miles };

  const preview = empty(resolved);
  for (const src of config.monday.sources) {
    const result = filterContacts(await monday.listContacts(src), mode);
    for (const c of result.matched) {
      preview.matches.push({ id: c.id, kind: src.kind, name: c.name, lat: c.lat as number, lng: c.lng as number });
    }
    preview.counts[src.kind] += result.matched.length;
    preview.skippedNoLocation[src.kind] += result.skippedNoLocation.length;
  }
  return preview;
}
