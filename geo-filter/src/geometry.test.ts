import { describe, expect, it } from 'vitest';
import { filterContacts, type Contact } from './geometry.js';

const contact = (overrides: Partial<Contact>): Contact => ({
  id: 'c1', name: 'Test Contact', lat: null, lng: null, zip: null, ...overrides,
});

describe('zip mode', () => {
  it('matches contacts whose zip is in the requested set', () => {
    const contacts = [
      contact({ id: '1', zip: '95113' }),
      contact({ id: '2', zip: '95110' }),
      contact({ id: '3', zip: '94301' }), // Palo Alto -- not requested
      contact({ id: '4', zip: null }), // no zip on file
    ];
    const { matched, skippedNoLocation } = filterContacts(contacts, { kind: 'zip', zips: ['95113', '95110'] });
    expect(matched.map((c) => c.id)).toEqual(['1', '2']);
    // Zip mode never needs coordinates -- a missing zip is a non-match, not a skip.
    expect(skippedNoLocation).toEqual([]);
  });
});

describe('radius mode', () => {
  // Diridon Station, San Jose.
  const diridon = { lat: 37.3297, lng: -121.9027 };

  it('matches a point essentially at the center and excludes one ~20 miles away', () => {
    const contacts = [
      contact({ id: 'near', lat: 37.33, lng: -121.903 }), // a couple hundred feet from Diridon
      contact({ id: 'far', lat: 37.6688, lng: -122.0808 }), // Redwood City, well outside 2 miles
      contact({ id: 'no-location', lat: null, lng: null }),
    ];
    const { matched, skippedNoLocation } = filterContacts(contacts, {
      kind: 'radius', center: diridon, radiusMiles: 2,
    });
    expect(matched.map((c) => c.id)).toEqual(['near']);
    expect(skippedNoLocation.map((c) => c.id)).toEqual(['no-location']);
  });

  it('a wide enough radius catches the previously-excluded far point', () => {
    const contacts = [contact({ id: 'far', lat: 37.6688, lng: -122.0808 })];
    const { matched } = filterContacts(contacts, { kind: 'radius', center: diridon, radiusMiles: 30 });
    expect(matched.map((c) => c.id)).toEqual(['far']);
  });
});

describe('corridor mode', () => {
  // A straight north-south line segment, standing in for a route/corridor like El Camino Real.
  const corridor = {
    type: 'LineString' as const,
    coordinates: [
      [-121.95, 37.35],
      [-121.95, 37.4],
    ],
  };

  it('matches a point on the line and excludes one several miles to the west', () => {
    const contacts = [
      contact({ id: 'on-line', lat: 37.375, lng: -121.95 }),
      contact({ id: 'near-line', lat: 37.375, lng: -121.951 }), // a couple hundred feet off the line
      contact({ id: 'far-away', lat: 37.375, lng: -122.5 }), // ~25 miles west
    ];
    const { matched } = filterContacts(contacts, { kind: 'corridor', geometry: corridor, bufferMiles: 1 });
    expect(matched.map((c) => c.id).sort()).toEqual(['near-line', 'on-line']);
  });

  it('reports contacts with no coordinates as skipped, not as non-matches silently', () => {
    const contacts = [contact({ id: 'ghost', lat: null, lng: null })];
    const { matched, skippedNoLocation } = filterContacts(contacts, {
      kind: 'corridor', geometry: corridor, bufferMiles: 1,
    });
    expect(matched).toEqual([]);
    expect(skippedNoLocation.map((c) => c.id)).toEqual(['ghost']);
  });
});
