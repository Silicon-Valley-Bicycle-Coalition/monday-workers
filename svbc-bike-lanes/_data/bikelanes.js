/**
 * Fetches bike lane data from MTC Regional Bike Facilities API
 * Aggregates by county and bike lane class type
 * Appends to history.json when running in CI environment
 */

const fs = require('fs');
const path = require('path');

// County bounding boxes (approximate, WGS84)
// Source: US Census TIGER/Line data
const COUNTIES = {
  'San Mateo': {
    fips: '06081',
    bounds: {
      xmin: -122.52,
      ymin: 37.11,
      xmax: -122.08,
      ymax: 37.71
    }
  },
  'Santa Clara': {
    fips: '06085',
    bounds: {
      xmin: -122.20,
      ymin: 36.89,
      xmax: -121.21,
      ymax: 37.48
    }
  }
};

// Bike lane class descriptions
const CLASS_NAMES = {
  1: 'Class I - Bike Path',
  2: 'Class II - Bike Lane',
  3: 'Class III - Bike Route',
  4: 'Class IV - Separated Bikeway'
};

const MTC_API_BASE = 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/regional_bike_facilities/FeatureServer/0';

/**
 * Calculate distance in miles between two coordinates using Haversine formula
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate total length of a polyline in miles
 */
function calculatePolylineLength(paths) {
  let totalLength = 0;
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const [lon1, lat1] = path[i];
      const [lon2, lat2] = path[i + 1];
      totalLength += haversineDistance(lat1, lon1, lat2, lon2);
    }
  }
  return totalLength;
}

/**
 * Query bike facilities within a bounding box
 */
async function queryBikeFacilities(bounds) {
  const geometry = JSON.stringify({
    xmin: bounds.xmin,
    ymin: bounds.ymin,
    xmax: bounds.xmax,
    ymax: bounds.ymax,
    spatialReference: { wkid: 4326 }
  });

  const params = new URLSearchParams({
    where: '1=1',
    geometry: geometry,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'class',
    returnGeometry: 'true',
    f: 'json'
  });

  const url = `${MTC_API_BASE}/query?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`API error: ${data.error.message}`);
  }

  return data.features || [];
}

/**
 * Aggregate features by class type and calculate miles
 */
function aggregateByClass(features) {
  const byClass = {};

  for (const feature of features) {
    const classType = feature.attributes.class;
    const miles = calculatePolylineLength(feature.geometry.paths);

    if (!byClass[classType]) {
      byClass[classType] = {
        class: classType,
        className: CLASS_NAMES[classType] || `Class ${classType}`,
        miles: 0,
        segments: 0
      };
    }

    byClass[classType].miles += miles;
    byClass[classType].segments += 1;
  }

  // Round miles and sort by class
  return Object.values(byClass)
    .map(item => ({
      ...item,
      miles: Math.round(item.miles * 100) / 100
    }))
    .sort((a, b) => a.class - b.class);
}

/**
 * Main data fetching function - called by 11ty at build time
 */
module.exports = async function() {
  console.log('Fetching bike lane data from MTC API...');

  const results = {
    fetchedAt: new Date().toISOString(),
    source: 'MTC Regional Bike Facilities',
    sourceUrl: 'https://opendata.mtc.ca.gov/datasets/regional-bike-facilities',
    counties: {},
    totals: {
      miles: 0,
      segments: 0,
      byClass: {}
    }
  };

  for (const [countyName, countyData] of Object.entries(COUNTIES)) {
    console.log(`  Fetching ${countyName} County...`);

    try {
      const features = await queryBikeFacilities(countyData.bounds);
      const byClass = aggregateByClass(features);

      const totalMiles = byClass.reduce((sum, item) => sum + item.miles, 0);
      const totalSegments = byClass.reduce((sum, item) => sum + item.segments, 0);

      results.counties[countyName] = {
        fips: countyData.fips,
        totalMiles: Math.round(totalMiles * 100) / 100,
        totalSegments: totalSegments,
        byClass: byClass
      };

      // Add to grand totals
      results.totals.miles += totalMiles;
      results.totals.segments += totalSegments;

      for (const item of byClass) {
        if (!results.totals.byClass[item.class]) {
          results.totals.byClass[item.class] = {
            class: item.class,
            className: item.className,
            miles: 0,
            segments: 0
          };
        }
        results.totals.byClass[item.class].miles += item.miles;
        results.totals.byClass[item.class].segments += item.segments;
      }

      console.log(`    Found ${totalSegments} segments, ${totalMiles.toFixed(2)} miles`);
    } catch (error) {
      console.error(`  Error fetching ${countyName} County:`, error.message);
      throw error; // Fail the build
    }
  }

  // Round and convert totals
  results.totals.miles = Math.round(results.totals.miles * 100) / 100;
  results.totals.byClass = Object.values(results.totals.byClass)
    .map(item => ({
      ...item,
      miles: Math.round(item.miles * 100) / 100
    }))
    .sort((a, b) => a.class - b.class);

  console.log(`Total: ${results.totals.segments} segments, ${results.totals.miles} miles`);

  // Append to history if running in CI environment
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  if (isCI) {
    await appendToHistory(results);
  } else {
    console.log('Skipping history update (not in CI environment)');
  }

  return results;
};

/**
 * Append current data snapshot to history.json
 * Only adds if no snapshot exists for today's date
 */
async function appendToHistory(data) {
  const historyPath = path.join(__dirname, 'history.json');

  // Read existing history
  let history = { snapshots: [] };
  try {
    const historyContent = fs.readFileSync(historyPath, 'utf8');
    history = JSON.parse(historyContent);
  } catch (error) {
    console.log('  Creating new history.json');
  }

  // Get today's date (YYYY-MM-DD)
  const today = new Date().toISOString().split('T')[0];

  // Check if snapshot for today already exists
  const existingSnapshot = history.snapshots.find(s => s.date === today);
  if (existingSnapshot) {
    console.log(`  History snapshot for ${today} already exists, skipping`);
    return;
  }

  // Create snapshot
  const snapshot = {
    date: today,
    fetchedAt: data.fetchedAt,
    totals: data.totals,
    counties: data.counties
  };

  // Append to history
  history.snapshots.push(snapshot);

  // Sort by date (oldest first)
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));

  // Write back to file
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');
  console.log(`  Added history snapshot for ${today}`);
}
