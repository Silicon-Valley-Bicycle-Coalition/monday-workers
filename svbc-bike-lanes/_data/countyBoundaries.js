/**
 * Fetches and caches real county boundary polygons for San Mateo and Santa
 * Clara Counties, from the US Census Bureau TIGERweb service.
 *
 * The MTC bike facilities query uses hand-picked rectangular bounding boxes
 * to fetch candidate segments, but those boxes are much larger than the
 * counties' true (non-rectangular) shape - roughly a third to two-fifths of
 * each box's area falls outside the actual county. Segments whose midpoint
 * isn't inside any known city polygon (rural land, bay-trail/levee
 * segments, bridge approaches) need to be checked against real county
 * geometry, not just the query bounding box, or they get attributed to
 * whichever county's box happens to contain them.
 */

const fs = require('fs');
const path = require('path');
const { pointInPolygon } = require('./cityBoundaries');

const COUNTY_API_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/82';

// Target counties (California state FIPS 06)
const TARGET_COUNTIES = {
  'San Mateo': '06081',
  'Santa Clara': '06085'
};

const CACHE_FILE = path.join(__dirname, 'countyBoundaries.cache.json');
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days - county lines rarely change

/**
 * Fetch county boundary polygons from Census TIGERweb
 */
async function fetchCountyBoundaries() {
  console.log('  Fetching county boundaries from Census TIGERweb...');

  const geoids = Object.values(TARGET_COUNTIES).map(id => `'${id}'`).join(',');
  const params = new URLSearchParams({
    where: `GEOID IN (${geoids})`,
    outFields: 'NAME,GEOID',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json'
  });

  const url = `${COUNTY_API_BASE}/query?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`County boundaries API request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`County boundaries API error: ${data.error.message}`);
  }

  const counties = {};
  for (const feature of data.features || []) {
    const name = feature.attributes.NAME.replace(' County', '');
    counties[name] = {
      name,
      rings: feature.geometry.rings
    };
  }

  console.log(`    Loaded boundaries for ${Object.keys(counties).length} counties`);
  return counties;
}

/**
 * Load county boundaries from cache or fetch fresh
 */
async function getCountyBoundaries() {
  try {
    const cacheContent = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache = JSON.parse(cacheContent);

    const cacheAge = Date.now() - new Date(cache.fetchedAt).getTime();
    if (cacheAge < CACHE_MAX_AGE_MS) {
      console.log('  Using cached county boundaries');
      return cache.counties;
    }
  } catch (error) {
    // Cache doesn't exist or is invalid
  }

  const counties = await fetchCountyBoundaries();

  const cache = {
    fetchedAt: new Date().toISOString(),
    counties
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log('  Cached county boundaries');

  return counties;
}

/**
 * Determine which county a point truly belongs to using real polygons,
 * rather than the query bounding boxes. Falls back to the nearest polygon
 * vertex when the point isn't inside any county's polygon (e.g. a bay-trail
 * levee or bridge-approach segment that sits just outside TIGER's land
 * boundary) so it still resolves to exactly one county instead of being
 * dropped or double-counted.
 */
function resolveCountyForPoint(lon, lat, countyBoundaries) {
  for (const county of Object.values(countyBoundaries)) {
    for (const ring of county.rings) {
      if (pointInPolygon(lon, lat, ring)) {
        return county.name;
      }
    }
  }

  let closest = null;
  let closestDist = Infinity;
  for (const county of Object.values(countyBoundaries)) {
    for (const ring of county.rings) {
      for (const [vx, vy] of ring) {
        const dist = Math.hypot(lon - vx, lat - vy);
        if (dist < closestDist) {
          closestDist = dist;
          closest = county.name;
        }
      }
    }
  }
  return closest;
}

module.exports = {
  getCountyBoundaries,
  resolveCountyForPoint
};
