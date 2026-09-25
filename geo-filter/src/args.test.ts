import { describe, expect, it } from 'vitest';
import { argValueFrom, buildFilterMode, parseNumberFlag } from './args.js';

const noFile = async (): Promise<string> => {
  throw new Error('unexpected file read');
};

const radius = (lat: string, lng: string, miles = '2') =>
  buildFilterMode('radius', argValueFrom(['--lat', lat, '--lng', lng, '--radius-miles', miles]), noFile);

describe('parseNumberFlag', () => {
  it('accepts an in-range number', () => {
    expect(parseNumberFlag('--lat', '37.3297', -90, 90)).toBe(37.3297);
    expect(parseNumberFlag('--lng', '-121.9027', -180, 180)).toBe(-121.9027);
  });

  it.each(['abc', '37.3o', '', ' ', 'NaN', 'Infinity'])('rejects non-numeric "%s"', (raw) => {
    expect(() => parseNumberFlag('--lat', raw, -90, 90)).toThrow('--lat must be a number between -90 and 90');
  });

  it.each(['90.1', '-91', '1e3'])('rejects out-of-range "%s"', (raw) => {
    expect(() => parseNumberFlag('--lat', raw, -90, 90)).toThrow(/--lat must be a number/);
  });
});

describe('buildFilterMode', () => {
  it('builds a radius mode from valid flags', async () => {
    expect(await radius('37.3297', '-121.9027')).toEqual({
      kind: 'radius', center: { lat: 37.3297, lng: -121.9027 }, radiusMiles: 2,
    });
  });

  it('rejects a bad --lat instead of producing NaN', async () => {
    await expect(radius('37.3o', '-121.9')).rejects.toThrow('--lat must be a number');
  });

  it('rejects an out-of-range --lng', async () => {
    await expect(radius('37.3', '-221.9')).rejects.toThrow('--lng must be a number');
  });

  it('rejects a negative --radius-miles', async () => {
    await expect(radius('37.3', '-121.9', '-1')).rejects.toThrow('--radius-miles must be a number');
  });

  it('rejects a non-numeric --buffer-miles before reading the GeoJSON', async () => {
    await expect(
      buildFilterMode('corridor', argValueFrom(['--geojson', 'x.geojson', '--buffer-miles', 'one']), noFile)
    ).rejects.toThrow('--buffer-miles must be a number');
  });

  it('reads a FeatureCollection for corridor mode', async () => {
    const line = { type: 'LineString', coordinates: [[-121.95, 37.35], [-121.95, 37.4]] };
    const fc = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: line }] });
    const mode = await buildFilterMode('corridor', argValueFrom(['--geojson', 'x.geojson', '--buffer-miles', '1']), async () => fc);
    expect(mode).toEqual({ kind: 'corridor', geometry: line, bufferMiles: 1 });
  });

  it('rejects an unknown mode', async () => {
    await expect(buildFilterMode('square', argValueFrom([]), noFile)).rejects.toThrow('unknown --mode "square"');
  });
});
