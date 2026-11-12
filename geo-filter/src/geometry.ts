// Pure geometry logic for the advocacy "contacts near a point or corridor" filter
// (svbc-monday-migration#24, generalizing migration-plan.md's Bike-lane GIS proximity). Kept
// free of any Monday/network dependency so it's directly unit-testable.

import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { buffer } from '@turf/buffer';
import { point as turfPoint } from '@turf/helpers';
import type { Feature, Geometry, Polygon, MultiPolygon } from 'geojson';

export interface Contact {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  zip: string | null;
}

export type FilterMode =
  // Exact 5-digit zip-code match (ZIP+4 reduced to its first five digits on both sides) — no
  // geometry involved, since the geocoding backfill already
  // captures Zip directly on every Donors item.
  | { kind: 'zip'; zips: string[] }
  // An N-mile radius around a single point, e.g. "2 mile radius from Diridon Station".
  | { kind: 'radius'; center: { lat: number; lng: number }; radiusMiles: number }
  // An N-mile buffer around an arbitrary line/polygon — a bike route, a corridor like
  // El Camino Real, or any other GeoJSON geometry (from OSM Overpass, a city's own project
  // page, or hand-drawn). Covers both the original bike-lane case and the general
  // "people who live within 1 mile of <corridor>" ask.
  | { kind: 'corridor'; geometry: Geometry; bufferMiles: number };

export interface FilterResult {
  matched: Contact[];
  skippedNoLocation: Contact[];
}

/** True if a contact has usable coordinates for geometry-based modes ('radius', 'corridor'). */
function hasCoordinates(c: Contact): c is Contact & { lat: number; lng: number } {
  return c.lat !== null && c.lng !== null && Number.isFinite(c.lat) && Number.isFinite(c.lng);
}

/**
 * Reduces a US ZIP or ZIP+4 (`95113-1234`, `95113 1234`, `951131234`) to its 5-digit ZIP so the
 * forms match each other. A 3–4-digit number is left-padded with zeros (`2134` → `02134`): a
 * Monday numbers column drops a ZIP's leading zeros. Anything else is just trimmed and compared
 * as-is.
 */
export function normalizeZip(zip: string): string {
  const trimmed = zip.trim();
  const match = /^(\d{5})(?:[-\s]?\d{4})?$/.exec(trimmed);
  if (match) return match[1]!;
  if (/^\d{3,4}$/.test(trimmed)) return trimmed.padStart(5, '0');
  return trimmed;
}

export function filterContacts(contacts: Contact[], mode: FilterMode): FilterResult {
  if (mode.kind === 'zip') {
    const zipSet = new Set(mode.zips.map(normalizeZip));
    // Zip matching never needs coordinates, so nothing is "skipped for no location" here —
    // a contact with no zip on file just doesn't match, same as any other non-match.
    return { matched: contacts.filter((c) => c.zip !== null && zipSet.has(normalizeZip(c.zip))), skippedNoLocation: [] };
  }

  const skippedNoLocation = contacts.filter((c) => !hasCoordinates(c));
  const withCoordinates = contacts.filter(hasCoordinates);

  if (mode.kind === 'radius') {
    const center = turfPoint([mode.center.lng, mode.center.lat]);
    const bufferMiles = mode.radiusMiles;
    const targetPolygon = buffer(center, bufferMiles, { units: 'miles' }) as Feature<Polygon | MultiPolygon> | null;
    if (!targetPolygon) return { matched: [], skippedNoLocation };
    const matched = withCoordinates.filter((c) =>
      booleanPointInPolygon(turfPoint([c.lng, c.lat]), targetPolygon)
    );
    return { matched, skippedNoLocation };
  }

  // 'corridor'
  const targetPolygon = buffer(mode.geometry, mode.bufferMiles, { units: 'miles' }) as Feature<Polygon | MultiPolygon> | null;
  if (!targetPolygon) return { matched: [], skippedNoLocation };
  const matched = withCoordinates.filter((c) =>
    booleanPointInPolygon(turfPoint([c.lng, c.lat]), targetPolygon)
  );
  return { matched, skippedNoLocation };
}
