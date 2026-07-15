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

// Bike lane class descriptions (to avoid circular dependency with bikelanes.js)
const CLASS_NAMES = {
  1: 'Class I - Bike Path',
  2: 'Class II - Bike Lane',
  3: 'Class III - Bike Route',
  4: 'Class IV - Separated Bikeway'
};

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
    // This source is comprehensive and should replace MTC data for this city
    comprehensive: true,
    // Matches the leading class number regardless of suffix, e.g.
    // "Class 1", "Class 2 (Buffered)", "Class 3 (Sharrow)", "Class 2 (BUFFERED)"
    classPattern: /Class\s*(\d)/i,
  }
};

/**
 * Extract the class number (1-4) from a raw bikeway class label
 */
function parseClassNumber(className, pattern) {
  if (!className) return null;
  const match = String(className).match(pattern);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Query San Jose bikeways for all existing classes
 */
async function querySanJoseBikeways() {
  const params = new URLSearchParams({
    where: "STATUS='Existing'",
    outFields: 'EXISTINGBIKEWAYCLASS,SEGMENTMILES',
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
 * Aggregate all San Jose bikeway data by class
 */
function aggregateSanJoseBikeways(features) {
  const byClass = {};
  let totalMiles = 0;

  for (const feature of features) {
    const miles = feature.attributes.SEGMENTMILES || 0;
    const className = feature.attributes.EXISTINGBIKEWAYCLASS;
    const classNum = parseClassNumber(className, SOURCES['San Jose'].classPattern);

    if (classNum && miles > 0) {
      if (!byClass[classNum]) {
        byClass[classNum] = {
          class: classNum,
          className: CLASS_NAMES[classNum] || `Class ${classNum}`,
          miles: 0,
          segments: 0,
          source: 'San Jose Open Data',
          sourceUrl: 'https://data.sanjoseca.gov/dataset/bikeways',
          supplemental: true
        };
      }
      byClass[classNum].miles += miles;
      byClass[classNum].segments += 1;
      totalMiles += miles;
    }
  }

  return {
    totalMiles: Math.round(totalMiles * 100) / 100,
    byClass: Object.values(byClass)
      .map(c => ({ ...c, miles: Math.round(c.miles * 100) / 100 }))
      .sort((a, b) => a.class - b.class)
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
    console.log('    Fetching all San Jose bikeways...');
    const features = await querySanJoseBikeways();
    const sanJoseData = aggregateSanJoseBikeways(features);

    if (!supplemental.counties['Santa Clara']) {
      supplemental.counties['Santa Clara'] = {
        cities: {}
      };
    }

    // Store the comprehensive data for San Jose
    supplemental.counties['Santa Clara'].cities['San Jose'] = sanJoseData;

    supplemental.sources.push({
      name: 'San Jose Open Data',
      url: 'https://data.sanjoseca.gov/dataset/bikeways',
      coverage: 'San Jose',
      dataType: 'All Bikeway Classes (comprehensive)',
      comprehensive: SOURCES['San Jose'].comprehensive
    });

    console.log(`      Found ${sanJoseData.totalMiles} total miles across ${sanJoseData.byClass.length} classes`);
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
