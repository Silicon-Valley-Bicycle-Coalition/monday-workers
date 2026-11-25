// Turns the Census 2010 ZCTA-to-county relationship file into attendeeSync.zipCounty.lists. The 2010
// file, because it counts the people in each part of a ZIP (POPPT); the 2020 one counts only land.

// County FIPS to its label. San Mateo and Santa Clara are in pledge.zipCounty already.
const COUNTIES = {
  '06001': 'Alameda', '06013': 'Contra Costa', '06041': 'Marin', '06053': 'Monterey', '06055': 'Napa', '06069': 'San Benito',
  '06075': 'San Francisco', '06087': 'Santa Cruz', '06095': 'Solano', '06097': 'Sonoma',
};

// Each ZIP goes to the county most of its people live in, whether or not that county is listed here.
export function zipCounties(census, knownZips) {
  const [header, ...lines] = census.trim().split(/\r?\n/);
  const names = header.split(',');
  const column = (name) => {
    const index = names.indexOf(name);
    if (index === -1) throw new Error(`the Census file has no ${name} column; use the 2010 ZCTA-to-county relationship file`);
    return index;
  };
  const [zipAt, countyAt, peopleAt] = [column('ZCTA5'), column('GEOID'), column('POPPT')];

  const largest = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const [zip, county, people] = [cells[zipAt], cells[countyAt], Number(cells[peopleAt])];
    if (!largest.has(zip) || people > largest.get(zip).people) largest.set(zip, { county, people });
  }

  const lists = {};
  for (const [zip, { county }] of [...largest].sort(([a], [b]) => a.localeCompare(b))) {
    const label = COUNTIES[county];
    if (label === undefined || knownZips.has(zip)) continue;
    (lists[label] ??= []).push(zip);
  }
  return Object.fromEntries(Object.entries(lists).sort(([a], [b]) => a.localeCompare(b)));
}
