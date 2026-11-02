import { describe, it, expect } from 'vitest';
import { validateConfig } from './config';

const address = { street: 'addr_street', city: 'addr_city', state: 'addr_state', zip: 'addr_zip' };

function fixture() {
  return {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      sources: [
        { kind: 'person', boardId: 101, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: 'nearby', address },
        { kind: 'historical', boardId: 102, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: 'nearby', address: null },
        { kind: 'organization', boardId: 103, latColumn: 'lat', lngColumn: 'lng', nameColumn: null, nearbyColumn: null, address },
      ],
      resultsWorkspaceIds: [7],
      eventsBoardId: 104,
      eventsAddressColumn: 'location',
    },
    osm: { nominatimUrl: 'https://nominatim.example', overpassUrl: 'https://overpass.example', userAgent: 'svbc-nearby-search (test)' },
    serviceArea: [36.9, -122.7, 37.8, -121.5],
    access: { teamDomain: 'svbc.cloudflareaccess.com', aud: 'aud-tag' },
    geocode: { censusUrl: 'https://census.example', perRun: 200 },
  };
}

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    const config = validateConfig(fixture());
    expect(config.monday.sources.map((s) => s.kind)).toEqual(['person', 'historical', 'organization']);
    expect(config.serviceArea).toEqual([36.9, -122.7, 37.8, -121.5]);
  });

  it('rejects a REPLACE_WITH_COLUMN_ID column', () => {
    const raw = fixture();
    raw.monday.sources[0]!.latColumn = 'REPLACE_WITH_COLUMN_ID';
    expect(() => validateConfig(raw)).toThrow('placeholder');
  });

  it('rejects a null board id (an unwired board)', () => {
    const raw = fixture() as any;
    raw.monday.sources[1].boardId = null;
    expect(() => validateConfig(raw)).toThrow('boardId');
  });

  it('rejects a serviceArea whose south is not below north', () => {
    const raw = fixture();
    raw.serviceArea = [37.8, -122.7, 36.9, -121.5];
    expect(() => validateConfig(raw)).toThrow('south');
    raw.serviceArea = [37.0, -122.7, 37.0, -121.5];
    expect(() => validateConfig(raw)).toThrow('south');
  });

  it('rejects a serviceArea whose west is not below east', () => {
    const raw = fixture();
    raw.serviceArea = [36.9, -121.5, 37.8, -122.7];
    expect(() => validateConfig(raw)).toThrow('west');
  });

  it.each(['person', 'historical', 'organization'])('rejects sources missing the %s board', (kind) => {
    const raw = fixture();
    raw.monday.sources = raw.monday.sources.filter((s) => s.kind !== kind);
    expect(() => validateConfig(raw)).toThrow(`no ${kind} board`);
  });

  it('accepts nearbyColumn null only for organization', () => {
    const raw = fixture() as any;
    expect(() => validateConfig(raw)).not.toThrow();
    raw.monday.sources[0].nearbyColumn = null;
    expect(() => validateConfig(raw)).toThrow('only for organization');
    raw.monday.sources[0].nearbyColumn = 'nearby';
    raw.monday.sources[1].nearbyColumn = null;
    expect(() => validateConfig(raw)).toThrow('only for organization');
  });
});
