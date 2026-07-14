/**
 * Fetches bike lane data from MTC Regional Bike Facilities API
 * Aggregates by county, city, and bike lane class type
 * Supplements with city-level data for Class IV (separated bikeways)
 * Appends to history.json when running in CI environment
 */

const fs = require('fs');
const path = require('path');
const { getCityBoundaries, findCityForPoint, getPolylineMidpoint } = require('./cityBoundaries');
const { getSupplementalData } = require('./supplementalSources');

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
 * Aggregate features by city using spatial intersection
 * Includes class breakdown per city
 * Returns both city data and features that belong to this county
 */
function aggregateByCity(features, cityBoundaries, countyName) {
  const byCity = {};
  const countyFeatures = []; // Track features that actually belong to this county

  for (const feature of features) {
    const classType = feature.attributes.class;
    const midpoint = getPolylineMidpoint(feature.geometry.paths);

    let cityName = 'Unincorporated';
    let belongsToCounty = true;

    if (midpoint) {
      const [lon, lat] = midpoint;
      const cityInfo = findCityForPoint(lon, lat, cityBoundaries);
      if (cityInfo) {
        if (cityInfo.county === countyName) {
          cityName = cityInfo.name;
        } else {
          // This segment is in another county's city - skip it
          // It will be counted when that county is processed
          belongsToCounty = false;
        }
      }
    }

    // Skip segments that belong to another county
    if (!belongsToCounty) {
      continue;
    }

    countyFeatures.push(feature);
    const miles = calculatePolylineLength(feature.geometry.paths);

    if (!byCity[cityName]) {
      byCity[cityName] = {
        name: cityName,
        miles: 0,
        segments: 0,
        byClass: {}
      };
    }

    byCity[cityName].miles += miles;
    byCity[cityName].segments += 1;

    // Track by class within city
    if (!byCity[cityName].byClass[classType]) {
      byCity[cityName].byClass[classType] = {
        class: classType,
        className: CLASS_NAMES[classType] || `Class ${classType}`,
        miles: 0,
        segments: 0
      };
    }
    byCity[cityName].byClass[classType].miles += miles;
    byCity[cityName].byClass[classType].segments += 1;
  }

  // Round miles and convert byClass to sorted array
  const citiesArray = Object.values(byCity)
    .map(city => ({
      ...city,
      miles: Math.round(city.miles * 100) / 100,
      byClass: Object.values(city.byClass)
        .map(item => ({
          ...item,
          miles: Math.round(item.miles * 100) / 100
        }))
        .sort((a, b) => a.class - b.class)
    }))
    .sort((a, b) => b.miles - a.miles);

  // Return both the city breakdown and the filtered features
  return {
    byCity: citiesArray,
    countyFeatures: countyFeatures
  };
}

/**
 * Main data fetching function - called by 11ty at build time
 */
module.exports = async function() {
  console.log('Fetching bike lane data from MTC API...');

  // Load city boundaries for spatial intersection
  const cityBoundaries = await getCityBoundaries();

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

      // First aggregate by city to filter out segments that belong to other counties
      const { byCity, countyFeatures } = aggregateByCity(features, cityBoundaries, countyName);

      // Use filtered features for class aggregation (excludes other-county segments)
      const byClass = aggregateByClass(countyFeatures);

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

      console.log(`    Found ${totalSegments} segments, ${totalMiles.toFixed(2)} miles in ${byCity.length} cities`);
    } catch (error) {
      console.error(`  Error fetching ${countyName} County:`, error.message);
      throw error; // Fail the build
    }
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
