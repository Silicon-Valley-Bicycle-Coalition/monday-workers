/**
 * Fetches and caches city boundary polygons for San Mateo and Santa Clara Counties
 * Uses California City Boundaries dataset from CA Open Data
 */

const fs = require('fs');
const path = require('path');

const CITY_API_BASE = 'https://services3.arcgis.com/uknczv4rpevve42E/arcgis/rest/services/California_Cities_and_Identifiers_Blue_Version_view/FeatureServer/2';

// Target counties
const TARGET_COUNTIES = ['San Mateo County', 'Santa Clara County'];

// Cache file path
const CACHE_FILE = path.join(__dirname, 'cityBoundaries.cache.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Ray casting algorithm for point-in-polygon test
 * Returns true if point (x, y) is inside the polygon
 */
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Fetch city boundaries from CA Open Data API
 */
async function fetchCityBoundaries() {
  console.log('  Fetching city boundaries from CA Open Data...');

  const params = new URLSearchParams({
    where: "CDTFA_COUNTY IN ('San Mateo County', 'Santa Clara County')",
    outFields: 'CENSUS_PLACE_NAME,CDTFA_COUNTY',
    returnGeometry: 'true',
    outSR: '4326', // Request WGS84 coordinates
    f: 'json'
  });

  const url = `${CITY_API_BASE}/query?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`City boundaries API request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`City boundaries API error: ${data.error.message}`);
  }

  // Process features into a simpler format
  const cities = {};

  for (const feature of data.features || []) {
    const name = feature.attributes.CENSUS_PLACE_NAME;
    const county = feature.attributes.CDTFA_COUNTY.replace(' County', '');

    if (!cities[name]) {
      cities[name] = {
        name: name,
        county: county,
        polygons: []
      };
    }

    // Handle polygon geometry (may have multiple rings)
    if (feature.geometry && feature.geometry.rings) {
      cities[name].polygons.push(feature.geometry.rings);
    }
  }

  const cityList = Object.values(cities);
  console.log(`    Loaded ${cityList.length} cities`);

  return cityList;
}

/**
 * Load city boundaries from cache or fetch fresh
 */
async function getCityBoundaries() {
  // Try to load from cache
  try {
    const cacheContent = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache = JSON.parse(cacheContent);

    const cacheAge = Date.now() - new Date(cache.fetchedAt).getTime();
    if (cacheAge < CACHE_MAX_AGE_MS) {
      console.log('  Using cached city boundaries');
      return cache.cities;
    }
  } catch (error) {
    // Cache doesn't exist or is invalid
  }

  // Fetch fresh data
  const cities = await fetchCityBoundaries();

  // Save to cache
  const cache = {
    fetchedAt: new Date().toISOString(),
    cities: cities
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log('  Cached city boundaries');

  return cities;
}

module.exports = {
  getCityBoundaries,
  pointInPolygon
};
