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
import { argValueFrom, buildFilterMode } from './args.js';
import { filterContacts, type FilterMode } from './geometry.js';
import { fetchContacts } from './monday.js';

const argValue = argValueFrom(process.argv);

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

let filterMode: FilterMode;
try {
  filterMode = await buildFilterMode(mode, argValue, (path) => readFile(path, 'utf8'));
} catch (err) {
  // Argument errors are the user's to fix — print the message, not a stack trace.
  console.error(`geo-filter: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const columns = {
  // Unset means the item's own name — see ColumnTitles.name.
  name: argValue('--name-column'),
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
