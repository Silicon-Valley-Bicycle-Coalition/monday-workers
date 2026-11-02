// Parses text pasted from a city notice ("Stevens Creek Blvd between Saratoga Ave and Winchester
// Blvd") into a location query. Pure functions: the OpenStreetMap lookups live elsewhere.
// Street names are expanded to OSM-style full names ("Boulevard", "East Meadow Drive") because
// Overpass matches way names against the full spelled-out name.

export type LocationQuery =
  | { kind: 'address'; text: string }
  | { kind: 'place'; text: string }
  | { kind: 'intersection'; a: string; b: string }
  | { kind: 'segment'; road: string; from: string; to: string };

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

// The final operand can carry a trailing city/state ("Winchester Blvd, San Jose"); cut it at the
// first comma or " in " / " near " so the street name is what gets expanded.
const cutTail = (s: string): string => clean(s.split(/,|\s+(?:in|near)\s+/i)[0]!);

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
    return {
      kind: 'segment',
      road: expandStreetName(clean(segment[1]!)),
      from: expandStreetName(clean(segment[2]!)),
      to: expandStreetName(cutTail(segment[3]!)),
    };
  }

  const intersection = /^(.+?)\s*(?:&|\/)\s*(.+)$|^(.+?)\s+(?:and|at)\s+(.+)$/i.exec(input);
  if (intersection) {
    const a = intersection[1] ?? intersection[3]!;
    const b = intersection[2] ?? intersection[4]!;
    return { kind: 'intersection', a: expandStreetName(clean(a)), b: expandStreetName(cutTail(b)) };
  }

  if (/^\d/.test(input)) return { kind: 'address', text: input };
  return { kind: 'place', text: input };
}
