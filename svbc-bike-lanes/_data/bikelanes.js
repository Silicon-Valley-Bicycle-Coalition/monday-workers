/**
 * Fetches bike lane data from MTC Regional Bike Facilities API
 * Aggregates by county, city, and bike lane class type
 * Supplements with city-level data for Class IV (separated bikeways)
 * Appends to history.json when running in CI environment
 */

const fs = require('fs');
const path = require('path');
const { getCityBoundaries } = require('./cityBoundaries');
const { getCountyBoundaries } = require('./countyBoundaries');
const { getSupplementalData } = require('./supplementalSources');
const { queryAllFeatures } = require('./arcgis');
const { buildBoundaryIndex, attributePolyline } = require('./clipping');

// Counties tracked. Their real (legal) boundaries come from Census TIGERweb
// via countyBoundaries.js; MTC segments are clipped to those polygons, so
// every mile is counted once, in the county and city it lies in.
const COUNTIES = {
  'San Mateo': { fips: '06081' },
  'Santa Clara': { fips: '06085' }
};

// Bike lane class descriptions
const CLASS_NAMES = {
  1: 'Class I - Bike Path',
  2: 'Class II - Bike Lane',
  3: 'Class III - Bike Route',
  4: 'Class IV - Separated Bikeway'
};

// Counting method, stored on each history snapshot. Totals from different
// methods aren't comparable, so the site marks a method break in the history
// instead of showing it as a change in miles. Snapshots without a method
// field predate versioning and count as method 1.
//   1: county bounding boxes, whole segments attributed by one point
//   2: segments clipped to real county and city boundaries; paged queries
//      (November 2026)
const METHOD_VERSION = 2;

const MTC_API_BASE = 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/regional_bike_facilities/FeatureServer/0';

/**
 * Query every bike facility intersecting the counties' combined extent.
 * The extent only narrows the download; clipping decides what counts.
 */
async function queryBikeFacilities(countyBoundaries) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const county of Object.values(countyBoundaries)) {
    for (const ring of county.rings) {
      for (const [x, y] of ring) {
        xmin = Math.min(xmin, x);
        xmax = Math.max(xmax, x);
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
    }
  }

  return queryAllFeatures(MTC_API_BASE, {
    where: '1=1',
    geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'objectid,class',
    returnGeometry: 'true',
    outSR: '4326'
  }, { orderByFields: 'objectid' });
}

function addMiles(byClass, classType, miles, segments) {
  if (!byClass[classType]) {
    byClass[classType] = {
      class: classType,
      className: CLASS_NAMES[classType] || `Class ${classType}`,
      miles: 0,
      segments: 0
    };
  }
  byClass[classType].miles += miles;
  byClass[classType].segments += segments;
}

function roundClasses(byClass) {
  return Object.values(byClass)
    .map(item => ({ ...item, miles: Math.round(item.miles * 100) / 100 }))
    .sort((a, b) => a.class - b.class);
}

/**
 * Clip every feature to the county and city polygons and total miles per
 * county, city, and class. A feature that crosses a boundary contributes
 * each part of its length to the place that part lies in; its segment
 * count goes to the place holding most of its length, so segment counts
 * still sum to the number of features counted. Parts outside both counties
 * are dropped.
 */
function aggregateByCounty(features, index) {
  const counties = {};
  for (const countyName of Object.keys(COUNTIES)) {
    counties[countyName] = { byClass: {}, byCity: {} };
  }

  for (const feature of features) {
    const classType = feature.attributes.class;
    const parts = attributePolyline(feature.geometry.paths, index)
      .filter(part => counties[part.county]);
    if (parts.length === 0) continue;

    const main = parts.reduce((a, b) => (b.miles > a.miles ? b : a));

    for (const part of parts) {
      const county = counties[part.county];
      const segments = part === main ? 1 : 0;
      if (!county.byCity[part.city]) {
        county.byCity[part.city] = { name: part.city, miles: 0, segments: 0, byClass: {} };
      }
      const city = county.byCity[part.city];
      city.miles += part.miles;
      city.segments += segments;
      addMiles(city.byClass, classType, part.miles, segments);
      addMiles(county.byClass, classType, part.miles, segments);
    }
  }

  for (const county of Object.values(counties)) {
    county.byClass = roundClasses(county.byClass);
    county.byCity = Object.values(county.byCity)
      .map(city => ({
        ...city,
        miles: Math.round(city.miles * 100) / 100,
        byClass: roundClasses(city.byClass)
      }))
      .sort((a, b) => b.miles - a.miles);
  }

  return counties;
}

/**
 * Add (sign 1) or remove (sign -1) a city's class miles from its county's
 * byClass, so the county breakdown follows a comprehensive city source that
 * replaces the MTC data for that city
 */
function adjustCountyClass(county, classData, sign) {
  let entry = county.byClass.find(c => c.class === classData.class);
  if (!entry) {
    entry = {
      class: classData.class,
      className: CLASS_NAMES[classData.class] || `Class ${classData.class}`,
      miles: 0,
      segments: 0,
      supplemental: true
    };
    county.byClass.push(entry);
    county.byClass.sort((a, b) => a.class - b.class);
  }
  entry.miles = Math.round((entry.miles + sign * classData.miles) * 100) / 100;
  entry.segments += sign * classData.segments;
}

/**
 * Main data fetching function - called by 11ty at build time
 */
module.exports = async function() {
  console.log('Fetching bike lane data from MTC API...');

  // Load city and county boundaries for spatial intersection
  const cityBoundaries = await getCityBoundaries();
  const countyBoundaries = await getCountyBoundaries();
  const index = buildBoundaryIndex(countyBoundaries, cityBoundaries);

  const results = {
    fetchedAt: new Date().toISOString(),
    method: METHOD_VERSION,
    source: 'MTC Regional Bike Facilities',
    sourceUrl: 'https://opendata.mtc.ca.gov/datasets/regional-bike-facilities',
    counties: {},
    totals: {
      miles: 0,
      segments: 0,
      byClass: {}
    }
  };

  const features = await queryBikeFacilities(countyBoundaries);
  console.log(`  Fetched ${features.length} MTC segments in the counties' extent`);
  const byCounty = aggregateByCounty(features, index);

  for (const [countyName, countyData] of Object.entries(COUNTIES)) {
    const { byClass, byCity } = byCounty[countyName];

    const totalMiles = byClass.reduce((sum, item) => sum + item.miles, 0);
    const totalSegments = byClass.reduce((sum, item) => sum + item.segments, 0);

    results.counties[countyName] = {
      fips: countyData.fips,
      totalMiles: Math.round(totalMiles * 100) / 100,
      totalSegments: totalSegments,
      byClass: byClass,
      byCity: byCity
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

    console.log(`  ${countyName} County: ${totalSegments} segments, ${totalMiles.toFixed(2)} miles in ${byCity.length} cities`);
  }

  // Fetch supplemental Class IV data from city sources
  const supplemental = await getSupplementalData();

  // Merge supplemental Class IV data
  for (const [countyName, countySupp] of Object.entries(supplemental.counties)) {
    if (results.counties[countyName]) {
      // Add Class IV to county byClass if not present
      const hasClass4 = results.counties[countyName].byClass.some(c => c.class === 4);
      if (!hasClass4 && countySupp.totalClass4Miles > 0) {
        results.counties[countyName].byClass.push({
          class: 4,
          className: CLASS_NAMES[4],
          miles: countySupp.totalClass4Miles,
          segments: 0, // Not tracked at segment level from supplemental
          source: 'Supplemental city data',
          supplemental: true
        });
        results.counties[countyName].byClass.sort((a, b) => a.class - b.class);

        // Update county total
        results.counties[countyName].totalMiles = Math.round(
          (results.counties[countyName].totalMiles + countySupp.totalClass4Miles) * 100
        ) / 100;

        // Add to grand totals
        results.totals.miles += countySupp.totalClass4Miles;

        // Add to totals byClass
        if (!results.totals.byClass[4]) {
          results.totals.byClass[4] = {
            class: 4,
            className: CLASS_NAMES[4],
            miles: 0,
            segments: 0,
            supplemental: true
          };
        }
        results.totals.byClass[4].miles += countySupp.totalClass4Miles;
      }

      // Add supplemental city data to city-level byClass arrays
      for (const [cityName, citySuppData] of Object.entries(countySupp.cities)) {
        const sourceConfig = supplemental.sources.find(s => s.coverage === cityName);
        const cityIndex = results.counties[countyName].byCity.findIndex(c => c.name === cityName);
        const cityEntry = cityIndex > -1 ? results.counties[countyName].byCity[cityIndex] : null;

        // Handle comprehensive sources (e.g., San Jose all classes)
        if (sourceConfig && sourceConfig.comprehensive) {
          console.log(`    Replacing MTC data for ${cityName} with comprehensive supplemental source.`);

          // 1. If city exists from MTC data, subtract its contribution from totals
          if (cityEntry) {
            results.totals.miles -= cityEntry.miles;
            results.counties[countyName].totalMiles -= cityEntry.miles;
            for (const classData of cityEntry.byClass) {
              const totalClassEntry = results.totals.byClass[classData.class];
              if (totalClassEntry) {
                totalClassEntry.miles -= classData.miles;
              }
              adjustCountyClass(results.counties[countyName], classData, -1);
            }
            // Remove the old MTC-based city entry
            results.counties[countyName].byCity.splice(cityIndex, 1);
          }

          // 2. Add the new comprehensive city data
          const newCityData = {
            name: cityName,
            miles: citySuppData.totalMiles,
            segments: citySuppData.byClass.reduce((sum, c) => sum + c.segments, 0),
            byClass: citySuppData.byClass,
          };
          results.counties[countyName].byCity.push(newCityData);

          // 3. Add new contributions to totals
          results.totals.miles += newCityData.miles;
          results.counties[countyName].totalMiles += newCityData.miles;
          for (const classData of newCityData.byClass) {
            let totalClassEntry = results.totals.byClass[classData.class];
            if (!totalClassEntry) {
              results.totals.byClass[classData.class] = { ...classData, miles: 0, segments: 0 };
              totalClassEntry = results.totals.byClass[classData.class];
            }
            totalClassEntry.miles += classData.miles;
            adjustCountyClass(results.counties[countyName], classData, 1);
          }
        // Handle non-comprehensive, Class IV-only sources
        } else if (cityEntry && citySuppData.class4) {
          const hasCityClass4 = cityEntry.byClass.some(c => c.class === 4);
          if (!hasCityClass4) {
            console.log(`    Adding supplemental Class IV data for ${cityName}.`);
            const class4Data = citySuppData.class4;

            // Add to city
            cityEntry.byClass.push(class4Data);
            cityEntry.byClass.sort((a, b) => a.class - b.class);
            cityEntry.miles = Math.round((cityEntry.miles + class4Data.miles) * 100) / 100;

            // Add to county total
            results.counties[countyName].totalMiles += class4Data.miles;

            // Add to grand totals
            results.totals.miles += class4Data.miles;
            let totalClass4 = results.totals.byClass[4];
            if (!totalClass4) {
              results.totals.byClass[4] = { ...class4Data, miles: 0, segments: 0 };
              totalClass4 = results.totals.byClass[4];
            }
            totalClass4.miles += class4Data.miles;
          }
        }
      }

      // Re-sort cities by mileage after modifications
      results.counties[countyName].byCity.sort((a, b) => b.miles - a.miles);
    }
  }

  // Store supplemental sources for display
  results.supplementalSources = supplemental.sources;

  // Round and convert totals
  results.totals.miles = Math.round(results.totals.miles * 100) / 100;
  results.totals.byClass = Object.values(results.totals.byClass)
    .map(item => ({
      ...item,
      miles: Math.round(item.miles * 100) / 100
    }))
    .sort((a, b) => a.class - b.class);

  console.log(`Total: ${results.totals.segments} segments, ${results.totals.miles} miles (including supplemental Class IV)`);

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
    method: data.method,
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
