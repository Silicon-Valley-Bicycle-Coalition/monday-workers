/**
 * Supplemental bike lane data sources
 * Fetches Class IV (separated bikeway) data from city-level sources
 * since MTC regional data doesn't include Class IV facilities
 */

const fs = require('fs');
const path = require('path');

// Cache settings
const CACHE_FILE = path.join(__dirname, 'supplementalSources.cache.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// San Jose Bikeways API
const SAN_JOSE_API = 'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService/MapServer/418';

/**
 * Supplemental data sources configuration
 */
const SOURCES = {
  'San Jose': {
    url: SAN_JOSE_API,
    county: 'Santa Clara',
    classField: 'EXISTINGBIKEWAYCLASS',
    statusField: 'STATUS',
    milesField: 'SEGMENTMILES',
    classMapping: {
      'Class 4': 4
    }
  }
};

/**
 * Query San Jose bikeways for Class IV data
 */
async function querySanJoseClass4() {
  const params = new URLSearchParams({
    where: "STATUS='Existing' AND EXISTINGBIKEWAYCLASS='Class 4'",
    outFields: 'EXISTINGBIKEWAYCLASS,SEGMENTMILES,STREETNAME,FULLSTREETNAME',
    returnGeometry: 'false',
    f: 'json'
  });

  const url = `${SAN_JOSE_API}/query?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`San Jose API request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`San Jose API error: ${data.error.message}`);
  }

  return data.features || [];
}

/**
 * Aggregate San Jose Class IV data
 */
function aggregateSanJoseClass4(features) {
  let totalMiles = 0;
  let segments = 0;

  for (const feature of features) {
    const miles = feature.attributes.SEGMENTMILES || 0;
    totalMiles += miles;
    segments += 1;
  }

  return {
    class: 4,
    className: 'Class IV - Separated Bikeway',
    miles: Math.round(totalMiles * 100) / 100,
    segments: segments,
    source: 'San Jose Open Data',
    sourceUrl: 'https://data.sanjoseca.gov/dataset/bikeways'
  };
}

/**
 * Fetch all supplemental Class IV data
 * Returns data organized by county and city
 */
async function fetchSupplementalData() {
  console.log('  Fetching supplemental Class IV data...');

  const supplemental = {
    fetchedAt: new Date().toISOString(),
    counties: {},
    sources: []
  };

  // Fetch San Jose Class IV
  try {
    console.log('    Fetching San Jose Class IV bikeways...');
    const features = await querySanJoseClass4();
    const class4Data = aggregateSanJoseClass4(features);

    if (!supplemental.counties['Santa Clara']) {
      supplemental.counties['Santa Clara'] = {
        cities: {},
        totalClass4Miles: 0
      };
    }

    supplemental.counties['Santa Clara'].cities['San Jose'] = {
      class4: class4Data
    };
    supplemental.counties['Santa Clara'].totalClass4Miles += class4Data.miles;

    supplemental.sources.push({
      name: 'San Jose Open Data',
      url: 'https://data.sanjoseca.gov/dataset/bikeways',
      coverage: 'San Jose',
      dataType: 'Class IV Separated Bikeways'
    });

    console.log(`      Found ${class4Data.segments} Class IV segments, ${class4Data.miles} miles`);
  } catch (error) {
    console.error('    Error fetching San Jose data:', error.message);
  }

  return supplemental;
}

/**
 * Get supplemental data from cache or fetch fresh
 */
async function getSupplementalData() {
  // Try to load from cache
  try {
    const cacheContent = fs.readFileSync(CACHE_FILE, 'utf8');
    const cache = JSON.parse(cacheContent);

    const cacheAge = Date.now() - new Date(cache.fetchedAt).getTime();
    if (cacheAge < CACHE_MAX_AGE_MS) {
      console.log('  Using cached supplemental data');
      return cache;
    }
  } catch (error) {
    // Cache doesn't exist or is invalid
  }

  // Fetch fresh data
  const data = await fetchSupplementalData();

  // Save to cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  console.log('  Cached supplemental data');

  return data;
}

module.exports = {
  getSupplementalData,
  SOURCES
};
