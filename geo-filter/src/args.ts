// Command-line parsing for cli.ts, kept separate from its top-level side effects (env check,
// Monday fetch, file write) so the validation is unit-testable.

import type { Geometry } from 'geojson';
import type { FilterMode } from './geometry.js';

/** Looks up a flag's value, e.g. `--lat 37.3` → `'37.3'`; undefined if the flag is absent. */
export type ArgValue = (flag: string) => string | undefined;

export function argValueFrom(argv: string[]): ArgValue {
  return (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
}

/**
 * Parses a numeric flag, rejecting anything that isn't a finite number within [min, max]. Plain
 * `Number()` would turn a typo like `--lat 37.3o` into NaN, which the geometry code then treats
 * as "no match" for every contact — a silently empty result instead of an error.
 */
export function parseNumberFlag(flag: string, raw: string, min: number, max: number): number {
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${flag} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

// Miles are only bounded to catch nonsense; 500 miles already covers all of California.
const MAX_MILES = 500;

export async function buildFilterMode(
  mode: string,
  argValue: ArgValue,
  readFile: (path: string) => Promise<string>
): Promise<FilterMode> {
  if (mode === 'zip') {
    const zips = argValue('--zips');
    if (!zips) throw new Error('--mode zip requires --zips <comma,separated,list>');
    return { kind: 'zip', zips: zips.split(',').map((z) => z.trim()).filter(Boolean) };
  }
  if (mode === 'radius') {
    const lat = argValue('--lat');
    const lng = argValue('--lng');
    const radiusMiles = argValue('--radius-miles');
    if (!lat || !lng || !radiusMiles) throw new Error('--mode radius requires --lat, --lng, and --radius-miles');
    return {
      kind: 'radius',
      center: { lat: parseNumberFlag('--lat', lat, -90, 90), lng: parseNumberFlag('--lng', lng, -180, 180) },
      radiusMiles: parseNumberFlag('--radius-miles', radiusMiles, 0, MAX_MILES),
    };
  }
  if (mode === 'corridor') {
    const geojsonPath = argValue('--geojson');
    const bufferMiles = argValue('--buffer-miles');
    if (!geojsonPath || !bufferMiles) throw new Error('--mode corridor requires --geojson <path> and --buffer-miles');
    const parsedBufferMiles = parseNumberFlag('--buffer-miles', bufferMiles, 0, MAX_MILES);
    const raw = JSON.parse(await readFile(geojsonPath));
    // Accept a bare Geometry, a Feature, or a FeatureCollection (buffering the first feature) —
    // whatever shape a human copied out of an Overpass query result or a city GIS export.
    const geometry: Geometry | undefined =
      raw.type === 'FeatureCollection' ? raw.features[0]?.geometry
      : raw.type === 'Feature' ? raw.geometry
      : raw;
    if (!geometry) throw new Error(`${geojsonPath} has no usable geometry`);
    return { kind: 'corridor', geometry, bufferMiles: parsedBufferMiles };
  }
  throw new Error(`unknown --mode "${mode}" (expected zip, radius, or corridor)`);
}
