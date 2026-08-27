import { describe, it, expect } from 'vitest';
import { buildListing, buildListingHtml } from './listing';
import type { CalendarsConfig } from './types';

const CONFIG: CalendarsConfig = {
  sources: [
    { id: 'santa-clara', name: 'Santa Clara', committeeName: 'Santa Clara BPAC', adapter: 'legistar', client: 'santaclara', bodyId: 232 },
    { id: 'eventbrite-public-events', name: 'SVBC Public Events', committeeName: 'SVBC Events — Public Events', adapter: 'eventbrite', organizerId: '123' },
  ],
};

describe('buildListing', () => {
  it('splits committee sources from Eventbrite sources', () => {
    const listing = buildListing(CONFIG, 'https://committees.bikesiliconvalley.org');
    expect(listing.committees).toEqual([{ id: 'santa-clara', label: 'Santa Clara', href: 'https://committees.bikesiliconvalley.org/calendars/santa-clara.ics' }]);
    expect(listing.events).toEqual([{ id: 'eventbrite-public-events', label: 'SVBC Events — Public Events', href: 'https://committees.bikesiliconvalley.org/calendars/eventbrite-public-events.ics' }]);
  });
});

describe('buildListingHtml', () => {
  it('renders both sections with escaped, linked hrefs', () => {
    const listing = buildListing(CONFIG, 'https://committees.bikesiliconvalley.org');
    const html = buildListingHtml(listing, '');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Santa Clara');
    expect(html).toContain('href="https://committees.bikesiliconvalley.org/calendars/santa-clara.ics"');
    expect(html).not.toContain('cloudflareinsights.com');
  });

  it('includes the Web Analytics beacon when a token is configured', () => {
    const html = buildListingHtml(buildListing(CONFIG, 'https://committees.bikesiliconvalley.org'), 'wa-token-123');
    expect(html).toContain('cloudflareinsights.com/beacon.min.js');
    expect(html).toContain('wa-token-123');
  });
});
