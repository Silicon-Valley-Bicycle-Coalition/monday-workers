#!/usr/bin/env node
// Advocacy "contacts near a point or corridor" filter — generalizes migration-plan.md's
// Bike-lane GIS proximity into a reusable tool (svbc-monday-migration#24). One-off, run on
// request per campaign; not standing infrastructure (see monday-workers/README.md).
//
// Three modes:
//   --mode zip       --zips 95113,95110
//   --mode radius    --lat 37.3297 --lng -121.9027 --radius-miles 2
//   --mode corridor  --geojson route.geojson --buffer-miles 1
//
// Usage:
//   MONDAY_API_TOKEN=... npm run cli -- --board <boardId> --mode radius \
//     --lat 37.3297 --lng -121.9027 --radius-miles 2 [--out matches.csv] \
//     [--lat-column Lat] [--lng-column Lng] [--zip-column Zip] [--name-column Name]
//
// For an existing, already-OSM-mapped route, fetch its geometry from the Overpass API first
// (https://wiki.openstreetmap.org/wiki/Overpass_API, e.g. a highway=cycleway query by bounding
// box) and save the result as GeoJSON for --geojson — this tool deliberately doesn't wrap that
// fetch itself, since a not-yet-built project's geometry (the original Benton Street Bikeway
// case) usually only exists on the city's own project pages, not in OSM, so a human has to
// source the GeoJSON either way.

import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Geometry } from 'geojson';
import { filterContacts, type FilterMode } from './geometry.js';
import { fetchContacts } from './monday.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error('geo-filter: MONDAY_API_TOKEN is required');
  process.exit(1);
}

const boardId = argValue('--board');
const mode = argValue('--mode');
if (!boardId || !mode) {
  console.error('geo-filter: --board <boardId> and --mode zip|radius|corridor are required');
  process.exit(1);
}

async function buildFilterMode(): Promise<FilterMode> {
  if (mode === 'zip') {
    const zips = argValue('--zips');
    if (!zips) throw new Error('--mode zip requires --zips <comma,separated,list>');
    return { kind: 'zip', zips: zips.split(',').map((z) => z.trim()).filter(Boolean) };
  }
  if (mode === 'radius') {
    const lat = argValue('--lat');
    const lng = argValue('--lng');
    const radiusMiles = argValue('--radius-miles');
    if (!lat || !lng || !radiusMiles) throw new Error('--mode radius requires --lat, --lng, and --radius-miles');
    return { kind: 'radius', center: { lat: Number(lat), lng: Number(lng) }, radiusMiles: Number(radiusMiles) };
  }
  if (mode === 'corridor') {
    const geojsonPath = argValue('--geojson');
    const bufferMiles = argValue('--buffer-miles');
    if (!geojsonPath || !bufferMiles) throw new Error('--mode corridor requires --geojson <path> and --buffer-miles');
    const raw = JSON.parse(await readFile(geojsonPath, 'utf8'));
    // Accept a bare Geometry, a Feature, or a FeatureCollection (buffering the first feature) —
    // whatever shape a human copied out of an Overpass query result or a city GIS export.
    const geometry: Geometry =
      raw.type === 'FeatureCollection' ? raw.features[0]?.geometry
      : raw.type === 'Feature' ? raw.geometry
      : raw;
    if (!geometry) throw new Error(`${geojsonPath} has no usable geometry`);
    return { kind: 'corridor', geometry, bufferMiles: Number(bufferMiles) };
  }
  throw new Error(`geo-filter: unknown --mode "${mode}" (expected zip, radius, or corridor)`);
}

const filterMode = await buildFilterMode();
const columns = {
  name: argValue('--name-column') ?? 'Name',
  lat: argValue('--lat-column') ?? 'Lat',
  lng: argValue('--lng-column') ?? 'Lng',
  zip: argValue('--zip-column') ?? 'Zip',
};
const outPath = argValue('--out') ?? 'geo-filter-matches.csv';

const contacts = await fetchContacts(token, boardId, columns);
const { matched, skippedNoLocation } = filterContacts(contacts, filterMode);

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = matched.map((c) => [c.id, c.name, c.lat, c.lng, c.zip]);
writeFileSync(
  outPath,
  ['id,name,lat,lng,zip', ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n',
  'utf8'
);

console.error(
  `geo-filter: ${matched.length} match(es) out of ${contacts.length} contacts on board ${boardId} ` +
  `written to ${outPath}` +
  (filterMode.kind === 'zip' ? '' : ` (${skippedNoLocation.length} contact(s) skipped for missing coordinates)`)
);
