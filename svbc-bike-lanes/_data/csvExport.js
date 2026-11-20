/**
 * Generates CSV export files for bike lane data
 * Creates both miles and kilometers versions
 */

const fs = require('fs');
const path = require('path');

// Conversion factor
const MI_TO_KM = 1.60934;

/**
 * Format number with proper precision
 */
function formatNum(num, decimals = 1) {
  if (num === null || num === undefined) return '';
  return (Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals)).toString();
}

/**
 * Format date as readable string
 */
function formatDate(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Escape CSV field (handle commas, quotes, newlines)
 */
function escapeCSV(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Generate CSV content for given unit
 */
function generateCSV(bikelanes, history, unit) {
  const isKm = unit === 'km';
  const unitLabel = isKm ? 'Kilometers' : 'Miles';
  const convert = (miles) => isKm ? miles * MI_TO_KM : miles;

  const lines = [];

  // Header
  lines.push('SVBC Bike Lane Tracker - Data Export');
  lines.push(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
  lines.push(`Units: ${unitLabel}`);
  lines.push(`Source: MTC Regional Bike Facilities`);
  lines.push('');

  // Regional Totals
  lines.push('REGIONAL TOTAL');
  lines.push(`Total ${unitLabel}`);
  lines.push(`${formatNum(convert(bikelanes.totals.miles))}`);
  lines.push('');

  // By Class
  lines.push('BY BIKE LANE CLASS');
  lines.push(`Class,${unitLabel}`);
  for (const item of bikelanes.totals.byClass) {
    lines.push(`${escapeCSV(item.className)},${formatNum(convert(item.miles))}`);
  }
  lines.push('');

  // City Details with class breakdown (bike lanes are administered by cities)
  for (const [countyName, county] of Object.entries(bikelanes.counties)) {
    lines.push(`CITIES - ${countyName.toUpperCase()} COUNTY`);
    lines.push(`City,Class I,Class II,Class III,Class IV,Total`);
    for (const city of county.byCity) {
      const class1 = city.byClass.find(c => c.class === 1);
      const class2 = city.byClass.find(c => c.class === 2);
      const class3 = city.byClass.find(c => c.class === 3);
      const class4 = city.byClass.find(c => c.class === 4);
      lines.push([
        escapeCSV(city.name),
        class1 ? formatNum(convert(class1.miles)) : '',
        class2 ? formatNum(convert(class2.miles)) : '',
        class3 ? formatNum(convert(class3.miles)) : '',
        class4 ? formatNum(convert(class4.miles)) : '',
        formatNum(convert(city.miles))
      ].join(','));
    }
    lines.push('');
  }

  // Historical Trends
  if (history.snapshots && history.snapshots.length > 0) {
    lines.push('HISTORICAL TRENDS');
    lines.push(`Date,Total ${unitLabel},Change,San Mateo,Santa Clara`);

    const snapshots = [...history.snapshots].reverse();
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i];
      const prevSnapshot = snapshots[i + 1];

      let change = '—';
      if (prevSnapshot && (snapshot.method || 1) !== (prevSnapshot.method || 1)) {
        change = 'method changed';
      } else if (prevSnapshot) {
        const diff = snapshot.totals.miles - prevSnapshot.totals.miles;
        const convertedDiff = convert(diff);
        const rounded = Math.round(convertedDiff * 10) / 10;
        if (rounded > 0) change = '+' + rounded;
        else if (rounded < 0) change = rounded.toString();
        else change = '0';
      }

      lines.push([
        formatDate(snapshot.date),
        formatNum(convert(snapshot.totals.miles)),
        change,
        formatNum(convert(snapshot.counties['San Mateo'].totalMiles)),
        formatNum(convert(snapshot.counties['Santa Clara'].totalMiles))
      ].join(','));
    }
  }

  return lines.join('\n');
}

/**
 * Write CSV files to output directory
 * Called during 11ty build via addPassthroughCopy or custom event
 */
async function writeCSVFiles(bikelanes, history, outputDir) {
  const dataDir = path.join(outputDir, 'data');

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Generate miles version
  const csvMiles = generateCSV(bikelanes, history, 'mi');
  fs.writeFileSync(path.join(dataDir, 'bike-lanes-mi.csv'), csvMiles);
  console.log('  Generated: data/bike-lanes-mi.csv');

  // Generate kilometers version
  const csvKm = generateCSV(bikelanes, history, 'km');
  fs.writeFileSync(path.join(dataDir, 'bike-lanes-km.csv'), csvKm);
  console.log('  Generated: data/bike-lanes-km.csv');
}

module.exports = {
  generateCSV,
  writeCSVFiles
};
