// Pure ACS parsing for the reference build: population (B01003) and median household income
// (B19013) per block group.
//
// The Census Data API (api.census.gov) now redirects keyless requests to missing_key.html, so the
// build reads the same estimates from the ACS table-based summary files on www2.census.gov
// (public, no key) and reshapes them into the API's table form with `summaryFileTable`.

const POP = 'B01003_001E';
const INCOME = 'B19013_001E';

/** An ACS estimate as a number; negative sentinels (-666666666 etc.) and non-numbers are null. */
export function acsValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** API-shaped rows (header first) → block-group GEOID → population and income. */
export function parseAcsRows(json) {
  const [header, ...rows] = json;
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`ACS table has no ${name} column`);
    return i;
  };
  const [pop, income, state, county, tract, bg] = [POP, INCOME, 'state', 'county', 'tract', 'block group'].map(col);
  const out = new Map();
  for (const r of rows) {
    out.set(r[state] + r[county] + r[tract] + r[bg], {
      population: acsValue(r[pop]) ?? 0,
      medianIncome: acsValue(r[income]),
    });
  }
  return out;
}

const BG_PREFIX = '1500000US'; // summary level 150 = block group

/** GEO_ID → first estimate column, for the block-group rows of one summary-file table. */
function blockGroupEstimates(dat) {
  const out = new Map();
  for (const line of dat.split(/\r?\n/)) {
    if (!line.startsWith(BG_PREFIX)) continue;
    const [geoId, estimate] = line.split('|');
    out.set(geoId.slice(BG_PREFIX.length), estimate);
  }
  return out;
}

/**
 * The B01003 and B19013 table-based summary files (pipe-delimited `.dat`) → the API's table
 * shape, limited to the given state's counties. A block group with no income row gets ''.
 */
export function summaryFileTable(populationDat, incomeDat, stateFips, countyFips) {
  const incomes = blockGroupEstimates(incomeDat);
  const table = [[POP, INCOME, 'state', 'county', 'tract', 'block group']];
  for (const [geoid, population] of blockGroupEstimates(populationDat)) {
    const state = geoid.slice(0, 2);
    const county = geoid.slice(2, 5);
    if (state !== stateFips || !countyFips.includes(county)) continue;
    table.push([population, incomes.get(geoid) ?? '', state, county, geoid.slice(5, 11), geoid.slice(11)]);
  }
  return table;
}
