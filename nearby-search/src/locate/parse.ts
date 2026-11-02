// Parses text pasted from a city notice ("Stevens Creek Blvd between Saratoga Ave and Winchester
// Blvd") into a location query. Pure functions: the OpenStreetMap lookups live elsewhere.
// Street names are expanded to OSM-style full names ("Boulevard", "East Meadow Drive") because
// Overpass matches way names against the full spelled-out name.

export type LocationQuery =
  | { kind: 'address'; text: string }
  | { kind: 'place'; text: string }
  // `city`: the trailing place an operand carried ("…, San Jose", "… in Campbell"), used to narrow
  // the lookup when a street pair exists in more than one city.
  | { kind: 'intersection'; a: string; b: string; city?: string }
  | { kind: 'segment'; road: string; from: string; to: string; city?: string };

const SUFFIXES: Record<string, string> = {
  st: 'Street',
  ave: 'Avenue',
  blvd: 'Boulevard',
  rd: 'Road',
  dr: 'Drive',
  ln: 'Lane',
  ct: 'Court',
  pl: 'Place',
  pkwy: 'Parkway',
  expy: 'Expressway',
  hwy: 'Highway',
  way: 'Way',
  ter: 'Terrace',
  cir: 'Circle',
};

const COMPASS: Record<string, string> = { n: 'North', s: 'South', e: 'East', w: 'West' };

const stripDot = (token: string): string => token.replace(/\.+$/, '');

export function expandStreetName(name: string): string {
  const tokens = name
    .trim()
    .replace(/[.,;]+$/, '')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return tokens.join(' ');

  const compass = COMPASS[stripDot(tokens[0]!).toLowerCase()];
  if (compass && /^[NSEWnsew]\.?$/.test(tokens[0]!)) tokens[0] = compass;

  const last = tokens.length - 1;
  const suffix = SUFFIXES[stripDot(tokens[last]!).toLowerCase()];
  if (suffix) tokens[last] = suffix;

  return tokens.join(' ');
}

const clean = (s: string): string => s.trim().replace(/[\s,;]+$/, '');

// Any operand can carry a trailing city/state ("Winchester Blvd, San Jose", "Bascom Ave in
// Campbell"); cut it at the first comma or " in " / " near " so the street name is what gets
// expanded. The text right after the cut ("San Jose" from "…, San Jose, CA") is the city.
function cutTail(s: string): { street: string; city: string | undefined } {
  const [street, city] = s.split(/,|\s+(?:in|near)\s+/i);
  const c = city?.trim();
  return { street: clean(street!), city: c ? c : undefined };
}

// Cuts every operand; the first city found (in operand order) is the query's.
function cutAll<K extends string>(operands: Record<K, string>): { names: Record<K, string>; city: string | undefined } {
  const names = {} as Record<K, string>;
  let city: string | undefined;
  for (const key of Object.keys(operands) as K[]) {
    const cut = cutTail(operands[key]);
    names[key] = expandStreetName(cut.street);
    city ??= cut.city;
  }
  return { names, city };
}

export function parseLocationText(text: string): LocationQuery | { kind: 'empty' } {
  const input = text
    .trim()
    .replace(/^on\s+/i, '')
    .replace(/^the\s+intersection\s+of\s+/i, '')
    .replace(/[.,;\s]+$/, '')
    .trim();
  if (!input) return { kind: 'empty' };

  const segment =
    /^(.+?)\s+between\s+(.+?)\s+(?:and|&)\s+(.+)$/i.exec(input) ??
    /^(.+?)\s+from\s+(.+?)\s+to\s+(.+)$/i.exec(input);
  if (segment) {
    const { names, city } = cutAll({ road: segment[1]!, from: segment[2]!, to: segment[3]! });
    return { kind: 'segment', ...names, ...(city ? { city } : {}) };
  }

  const intersection = /^(.+?)\s*(?:&|\/)\s*(.+)$|^(.+?)\s+(?:and|at)\s+(.+)$/i.exec(input);
  if (intersection) {
    const a = intersection[1] ?? intersection[3]!;
    const b = intersection[2] ?? intersection[4]!;
    const { names, city } = cutAll({ a, b });
    return { kind: 'intersection', ...names, ...(city ? { city } : {}) };
  }

  if (/^\d/.test(input)) return { kind: 'address', text: input };
  return { kind: 'place', text: input };
}
