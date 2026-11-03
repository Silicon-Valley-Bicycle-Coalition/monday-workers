#!/usr/bin/env node
// Offline reference-data build: `npm run build:reference` (from member-map/).
//
// Downloads public Census, MTC and San Jose data for the counties in config/reference.json and
// writes the four static files the map serves from public/data/:
//   blockgroups.geojson   block groups with population, income, EPC flag, road and bike miles
//   epc.geojson           Equity Priority Community tract outlines
//   bikelanes.geojson     bike facilities by class (MTC, with San Jose's own layer inside San Jose)
//   reference-meta.json   build time and the sources used
// Downloads are cached under .cache/reference/ (gitignored); delete it to re-download.
// Every source is a public, unauthenticated GET. Nothing here writes anywhere but this repo.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import * as shapefile from 'shapefile';
import mapshaper from 'mapshaper';
import {
  bbox, bboxPolygon, booleanPointInPolygon, difference, featureCollection, pointOnFeature, union,
} from '@turf/turf';
import { dropInside, lineMiles, milesByPolygon, weightedMiles } from '../src/reference/lines.ts';
import { classify } from '../src/score.ts';
import { parseAcsRows, summaryFileTable } from './acs.mjs';
import { sanJoseClass } from './bike-classes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'reference');
const OUT = join(ROOT, 'public', 'data');
const config = JSON.parse(await readFile(join(ROOT, 'config', 'reference.json'), 'utf8'));
const { stateFips, counties, acsYear, tigerYear, minPopulation, roadMtfcc, bikeClassWeights } = config;
const countyFips = counties.map((c) => c.fips);
const CLASSES = ['1', '2', '3', '4'];

// ── Sources ──────────────────────────────────────────────────────────────────────────────────
const CENSUS = 'https://www2.census.gov';
const URLS = {
  blockGroups: `${CENSUS}/geo/tiger/GENZ${tigerYear}/shp/cb_${tigerYear}_${stateFips}_bg_500k.zip`,
  places: `${CENSUS}/geo/tiger/GENZ${tigerYear}/shp/cb_${tigerYear}_${stateFips}_place_500k.zip`,
  roads: (fips) => `${CENSUS}/geo/tiger/TIGER${tigerYear}/ROADS/tl_${tigerYear}_${stateFips}${fips}_roads.zip`,
  // api.census.gov now requires a key; the table-based summary files carry the same estimates.
  acs: (table) =>
    `${CENSUS}/programs-surveys/acs/summary_file/${acsYear}/table-based-SF/data/5YRData/acsdt5y${acsYear}-${table}.dat`,
  // Legal county boundaries (they run out into the bay and ocean, unlike the cartographic files).
  counties: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query',
  mtcBike: 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/regional_bike_facilities/FeatureServer/0/query',
  sjBike: 'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/418/query',
  // Plan Bay Area 2050+ EPCs = the ACS 2014-2018 set (PBA 2050, on 2010 tracts) plus the ACS
  // 2018-2022 set (2020 tracts). MTC publishes them as two layers.
  epc2018: 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/equity_priority_communities_2025_acs2018/FeatureServer/0/query',
  epc2022: 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/draft_equity_priority_communities_pba2050plus_acs2022a/FeatureServer/0/query',
};
const SAN_JOSE_PLACE_GEOID = '0668000';

// ── Download + cache ─────────────────────────────────────────────────────────────────────────
async function cached(name, produce) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFile(path);
  const body = await produce();
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, body);
  return body;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const download = (url) => cached(url.split('/').pop(), () => get(url));

/** Every page of an ArcGIS query (resultOffset/resultRecordCount until no exceededTransferLimit). */
async function arcgisAll(name, url, params) {
  const body = await cached(`${name}.json`, async () => {
    const features = [];
    const pageSize = 1000; // under both services' maxRecordCount (2000)
    for (let offset = 0; ; offset += pageSize) {
      const qs = new URLSearchParams({ ...params, resultOffset: String(offset), resultRecordCount: String(pageSize) });
      const data = JSON.parse((await get(`${url}?${qs}`)).toString('utf8'));
      if (data.error) throw new Error(`${name}: ${data.error.message ?? JSON.stringify(data.error)}`);
      features.push(...data.features);
      const more = data.exceededTransferLimit ?? data.properties?.exceededTransferLimit ?? false;
      if (!more) break;
    }
    return JSON.stringify(features);
  });
  return JSON.parse(body.toString('utf8'));
}

async function readShapefile(zip, base) {
  const files = unzipSync(new Uint8Array(zip));
  const pick = (ext) => {
    const entry = Object.keys(files).find((k) => k.toLowerCase() === `${base}.${ext}`.toLowerCase());
    if (!entry) throw new Error(`${base}.${ext} missing from zip`);
    return files[entry];
  };
  const fc = await shapefile.read(pick('shp'), pick('dbf'), { encoding: 'utf-8' });
  return fc.features;
}

/** An Esri JSON polyline → a GeoJSON LineString/MultiLineString feature. */
function esriLine(feature, properties) {
  const paths = feature.geometry?.paths ?? [];
  const geometry = paths.length === 1
    ? { type: 'LineString', coordinates: paths[0] }
    : { type: 'MultiLineString', coordinates: paths };
  return { type: 'Feature', properties, geometry };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────
const featureMiles = (f) =>
  f.geometry.type === 'LineString'
    ? lineMiles(f.geometry.coordinates)
    : f.geometry.coordinates.reduce((s, c) => s + lineMiles(c), 0);
const sumMiles = (lines) => lines.reduce((s, f) => s + featureMiles(f), 0);
const sumMap = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const fmt = (n) => (Math.abs(n) < 0.05 ? 0 : n).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

async function simplify(fc, command) {
  const out = await mapshaper.applyCommands(
    `-i in.json ${command} -o out.json format=geojson precision=0.000001`,
    { 'in.json': JSON.stringify(fc) },
  );
  return out['out.json'].toString();
}

// ── Build ────────────────────────────────────────────────────────────────────────────────────
console.log('Block groups…');
const bgFeatures = (await readShapefile(await download(URLS.blockGroups), `cb_${tigerYear}_${stateFips}_bg_500k`))
  .filter((f) => countyFips.includes(f.properties.COUNTYFP));
const blockGroups = bgFeatures.map((f) => ({ type: 'Feature', properties: { GEOID: f.properties.GEOID }, geometry: f.geometry }));
const area = bbox(featureCollection(blockGroups));

console.log('ACS…');
const acs = parseAcsRows(summaryFileTable(
  (await download(URLS.acs('b01003'))).toString('utf8'),
  (await download(URLS.acs('b19013'))).toString('utf8'),
  stateFips,
  countyFips,
));
const missingAcs = blockGroups.filter((f) => !acs.has(f.properties.GEOID)).length;

console.log('Equity Priority Communities…');
const countyList = countyFips.map((c) => `'${c}'`).join(',');
const epc2022Rows = await arcgisAll('epc2022', URLS.epc2022, {
  where: `county_fip IN (${countyFips.map(Number).join(',')}) AND epc_2050p = 1`,
  outFields: 'tract_geoid', returnGeometry: 'false', orderByFields: 'OBJECTID', f: 'json',
});
const epc2018Polys = await arcgisAll('epc2018', URLS.epc2018, {
  where: `county_fip IN (${countyList}) AND epc_2050 = 1`,
  outFields: 'geoid', outSR: '4326', orderByFields: 'OBJECTID', f: 'geojson',
});
const epcTracts2022 = new Set(epc2022Rows.map((r) => r.attributes.tract_geoid));
// The 2014-2018 set is on 2010 tracts. Carry it to 2020 tracts spatially: a 2020 tract counts
// when at least half of its block groups have their interior point inside a 2014-2018 EPC.
const tractVotes = new Map(); // tract → [inside, total]
for (const bg of blockGroups) {
  const tract = bg.properties.GEOID.slice(0, 11);
  const p = pointOnFeature(bg);
  const inside = epc2018Polys.some((e) => booleanPointInPolygon(p, e));
  const [i, n] = tractVotes.get(tract) ?? [0, 0];
  tractVotes.set(tract, [i + (inside ? 1 : 0), n + 1]);
}
const epcTracts2018 = new Set([...tractVotes].filter(([, [i, n]]) => i * 2 >= n && i > 0).map(([t]) => t));
const epcTracts = new Set([...epcTracts2022, ...epcTracts2018].filter((t) => tractVotes.has(t)));

console.log('Roads…');
const roads = [];
const seenRoad = new Set(); // a road on the county line is in both county files
for (const fips of countyFips) {
  const features = await readShapefile(await download(URLS.roads(fips)), `tl_${tigerYear}_${stateFips}${fips}_roads`);
  for (const f of features) {
    if (!roadMtfcc.includes(f.properties.MTFCC)) continue;
    const key = JSON.stringify(f.geometry.coordinates);
    if (seenRoad.has(key)) continue;
    seenRoad.add(key);
    roads.push({ type: 'Feature', properties: {}, geometry: f.geometry });
  }
}

console.log('County and San Jose boundaries…');
const countyShapes = JSON.parse((await cached('tigerweb-counties.json', () => get(`${URLS.counties}?${new URLSearchParams({
  where: `STATE='${stateFips}' AND COUNTY IN (${countyList})`,
  outFields: 'GEOID,NAME', returnGeometry: 'true', outSR: '4326', f: 'geojson',
})}`))).toString('utf8')).features;
if (countyShapes.length !== countyFips.length) throw new Error(`expected ${countyFips.length} counties, got ${countyShapes.length}`);
const countyArea = countyShapes.length > 1 ? union(featureCollection(countyShapes)) : countyShapes[0];
// Everything in a padded box except the counties: dropInside(lines, outside) keeps the in-county pieces.
const pad = 0.5;
const outsideCounties = difference(featureCollection([
  bboxPolygon([area[0] - pad, area[1] - pad, area[2] + pad, area[3] + pad]), countyArea,
]));
const keepInCounties = (lines) => dropInside(lines, outsideCounties);
const sanJose = (await readShapefile(await download(URLS.places), `cb_${tigerYear}_${stateFips}_place_500k`))
  .find((f) => f.properties.GEOID === SAN_JOSE_PLACE_GEOID);
if (!sanJose) throw new Error('San Jose not found in the place file');

console.log('Bike facilities…');
const envelope = { xmin: area[0], ymin: area[1], xmax: area[2], ymax: area[3], spatialReference: { wkid: 4326 } };
const mtcRaw = await arcgisAll('mtc-bike', URLS.mtcBike, {
  where: '1=1', geometry: JSON.stringify(envelope), geometryType: 'esriGeometryEnvelope', inSR: '4326',
  spatialRel: 'esriSpatialRelIntersects', outFields: 'class,objectid', returnGeometry: 'true', outSR: '4326',
  orderByFields: 'objectid', f: 'json',
});
const mtcById = new Map(mtcRaw.map((f) => [f.attributes.objectid ?? f.attributes.OBJECTID, f]));
const sjRaw = await arcgisAll('sj-bike', URLS.sjBike, {
  where: "STATUS='Existing'", outFields: 'EXISTINGBIKEWAYCLASS,OBJECTID', returnGeometry: 'true', outSR: '4326',
  orderByFields: 'OBJECTID', f: 'json',
});
const sjValueCounts = {};
for (const f of sjRaw) {
  const v = String(f.attributes.EXISTINGBIKEWAYCLASS);
  sjValueCounts[v] = (sjValueCounts[v] ?? 0) + 1;
}

const mtcByClass = Object.fromEntries(CLASSES.map((c) => [c, []]));
const mtcOtherClasses = {};
for (const f of mtcById.values()) {
  const c = String(f.attributes.class);
  if (mtcByClass[c]) mtcByClass[c].push(esriLine(f, {}));
  else mtcOtherClasses[c] = (mtcOtherClasses[c] ?? 0) + 1;
}
const sjByClass = Object.fromEntries(CLASSES.map((c) => [c, []]));
for (const f of sjRaw) {
  const c = sanJoseClass(f.attributes.EXISTINGBIKEWAYCLASS);
  if (c !== null) sjByClass[String(c)].push(esriLine(f, {}));
}

console.log('Attributing miles to block groups (slow)…');
const bikeLines = {}; // class → in-county pieces, MTC outside San Jose + San Jose's own
const bikeByBg = {}; // class → GEOID → miles
const bikeStats = {};
for (const c of CLASSES) {
  const mtcInCounties = keepInCounties(mtcByClass[c]);
  const lines = keepInCounties([...dropInside(mtcByClass[c], sanJose), ...sjByClass[c]]);
  bikeLines[c] = lines;
  bikeByBg[c] = milesByPolygon(lines, blockGroups);
  const fetched = sumMiles(lines);
  const attributed = sumMap(bikeByBg[c]);
  bikeStats[c] = { mtcInCounties: sumMiles(mtcInCounties), fetched, attributed, unattributed: fetched - attributed };
  console.log(`  class ${c} done`);
}
const roadByBg = milesByPolygon(roads, blockGroups);
const roadFetched = sumMiles(roads);
const roadAttributed = sumMap(roadByBg);

// ── Properties ───────────────────────────────────────────────────────────────────────────────
const props = blockGroups.map((bg) => {
  const GEOID = bg.properties.GEOID;
  const a = acs.get(GEOID) ?? { population: 0, medianIncome: null };
  const bikeMiles = Object.fromEntries(CLASSES.map((c) => [c, round(bikeByBg[c].get(GEOID) ?? 0)]));
  const roadMiles = round(roadByBg.get(GEOID) ?? 0);
  const weightedBikeMiles = round(weightedMiles(bikeMiles, bikeClassWeights));
  return {
    GEOID,
    population: a.population,
    medianIncome: a.medianIncome,
    epc: epcTracts.has(GEOID.slice(0, 11)),
    roadMiles,
    bikeMiles,
    weightedBikeMiles,
    bikeDensity: roadMiles === 0 ? null : round(weightedBikeMiles / roadMiles, 4),
    bikeClass: null,
  };
});
// Tiny block groups (parks, industrial land) stay unscored so they don't read as false gaps.
const classes = classify(props.map((p) => (p.population < minPopulation ? null : p.bikeDensity)), 'low-is-gap');
props.forEach((p, i) => { p.bikeClass = classes[i]; });

// ── Write ────────────────────────────────────────────────────────────────────────────────────
console.log('Simplifying and writing…');
await mkdir(OUT, { recursive: true });
const bgOut = await simplify(
  featureCollection(blockGroups.map((bg, i) => ({ ...bg, properties: props[i] }))),
  '-simplify 15% keep-shapes planar',
);
// EPC outlines are dissolved from the simplified block groups so they line up with them exactly.
const epcOut = await mapshaper.applyCommands(
  '-i bg.json -filter "epc === true" -each "tract = GEOID.slice(0, 11)" -dissolve tract -o epc.json format=geojson precision=0.000001',
  { 'bg.json': bgOut },
).then((o) => o['epc.json'].toString());
const bikeSimplified = JSON.parse(await simplify(
  featureCollection(CLASSES.flatMap((c) => bikeLines[c].map((f) => ({ ...f, properties: { class: Number(c) } })))),
  '-simplify 30% planar',
));
// Simplifying and rounding can collapse a tiny split piece to nothing; drop those.
const bikeOut = JSON.stringify(featureCollection(bikeSimplified.features.filter((f) => f.geometry)));
const meta = {
  builtAt: new Date().toISOString(),
  sources: [
    { name: 'Census cartographic boundary block groups (500k)', url: URLS.blockGroups, vintage: String(tigerYear) },
    { name: 'ACS 5-year B01003 total population (table-based summary file)', url: URLS.acs('b01003'), vintage: `${acsYear - 4}-${acsYear}` },
    { name: 'ACS 5-year B19013 median household income (table-based summary file)', url: URLS.acs('b19013'), vintage: `${acsYear - 4}-${acsYear}` },
    ...countyFips.map((f) => ({ name: `TIGER/Line roads, county ${f}, MTFCC ${roadMtfcc.join('/')}`, url: URLS.roads(f), vintage: String(tigerYear) })),
    { name: 'Census cartographic boundary places (San Jose, GEOID 0668000)', url: URLS.places, vintage: String(tigerYear) },
    { name: 'TIGERweb counties (legal boundaries, clip for bike lines)', url: URLS.counties, vintage: 'TIGERweb current' },
    { name: 'MTC regional bike facilities (field class)', url: URLS.mtcBike, vintage: `fetched ${new Date().toISOString().slice(0, 10)}` },
    { name: "San Jose bikeways, STATUS='Existing' (field EXISTINGBIKEWAYCLASS)", url: URLS.sjBike, vintage: `fetched ${new Date().toISOString().slice(0, 10)}` },
    { name: 'MTC Equity Priority Communities, Plan Bay Area 2050+, ACS 2018-2022 (2020 tracts; tract field tract_geoid, flag epc_2050p = 1)', url: URLS.epc2022, vintage: 'ACS 2018-2022' },
    { name: 'MTC Equity Priority Communities, Plan Bay Area 2050+, ACS 2014-2018 (2010 tracts; tract field geoid, flag epc_2050 = 1; carried to 2020 tracts by block-group interior points)', url: URLS.epc2018, vintage: 'ACS 2014-2018' },
  ],
};
const files = {
  'blockgroups.geojson': bgOut,
  'epc.geojson': epcOut,
  'bikelanes.geojson': bikeOut,
  'reference-meta.json': `${JSON.stringify(meta, null, 2)}\n`,
};
for (const [name, body] of Object.entries(files)) await writeFile(join(OUT, name), body);

// ── Summary ──────────────────────────────────────────────────────────────────────────────────
const totalPop = props.reduce((s, p) => s + p.population, 0);
console.log('\nSummary');
console.log(`  block groups:            ${props.length} (${missingAcs} without an ACS row)`);
console.log(`  total population:        ${totalPop.toLocaleString('en-US')}`);
console.log(`  EPC tracts:              ${epcTracts.size} (ACS 2018-2022: ${[...epcTracts2022].filter((t) => tractVotes.has(t)).length}, ACS 2014-2018 carried: ${epcTracts2018.size})`);
console.log(`  EPC block groups:        ${props.filter((p) => p.epc).length}`);
console.log(`  scored for bike density: ${classes.filter((c) => c !== null).length} (under ${minPopulation} residents or no roads: unscored)`);
console.log(`  road miles (${roadMtfcc.join('/')}): fetched ${fmt(roadFetched)}, attributed ${fmt(roadAttributed)}, credited to no block group ${fmt(roadFetched - roadAttributed)}`);
console.log('  bike miles by class (in the two counties; MTC outside San Jose + San Jose layer):');
for (const c of CLASSES) {
  const s = bikeStats[c];
  console.log(`    class ${c}: fetched ${fmt(s.fetched)}, attributed ${fmt(s.attributed)}, credited to no block group ${fmt(s.unattributed)}  [MTC alone, in the counties: ${fmt(s.mtcInCounties)}]`);
}
console.log(`  MTC features: ${mtcRaw.length} fetched, ${mtcById.size} unique${Object.keys(mtcOtherClasses).length ? `, other classes skipped ${JSON.stringify(mtcOtherClasses)}` : ''}`);
console.log(`  San Jose features: ${sjRaw.length}; EXISTINGBIKEWAYCLASS values ${JSON.stringify(sjValueCounts)}`);
for (const name of Object.keys(files)) {
  console.log(`  ${name}: ${((await stat(join(OUT, name))).size / 1e6).toFixed(2)} MB`);
}
