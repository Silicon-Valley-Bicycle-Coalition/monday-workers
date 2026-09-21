import { describe, it, expect } from 'vitest';
import { eventsListView, eventsUnavailableView } from './eventViews';
import type { EventRegistrationListing } from './loadEventRegistrations';

function listing(overrides: Partial<EventRegistrationListing>): EventRegistrationListing {
  return { donorId: 'donor-1', donorName: 'Jane Donor', upcoming: [], past: [], ...overrides };
}

describe('eventsListView', () => {
  it('renders upcoming and past sections with event name, date, and past attendance', () => {
    const html = eventsListView(
      [
        listing({
          upcoming: [{ registrationName: 'reg-a', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false }],
          past: [
            { registrationName: 'reg-b', eventName: 'Bike Summit', eventDate: '2026-04-12', attended: true },
            { registrationName: 'reg-c', eventName: 'Spring Ride', eventDate: '2026-03-01', attended: false },
          ],
        }),
      ],
      'en'
    );

    expect(html).toContain('Jane Donor');
    expect(html).toContain('Upcoming');
    expect(html).toContain('Fall Gala');
    expect(html).toContain('2026-10-03');
    expect(html).toContain('Past');
    expect(html).toContain('Bike Summit');
    expect(html).toContain('Attended');
    expect(html).toContain('Registered');
  });

  it('falls back to the registration name when the event link resolved to nothing', () => {
    const html = eventsListView(
      [listing({ past: [{ registrationName: 'Mystery signup', eventName: '', eventDate: '', attended: false }] })],
      'en'
    );

    expect(html).toContain('Mystery signup');
  });

  it('shows a per-donor empty state when a donor has no registrations at all', () => {
    const html = eventsListView([listing({ donorName: 'Joan Donor' })], 'en');

    expect(html).toContain('Joan Donor');
    expect(html).toContain('No event registrations');
  });

  it('escapes HTML in Monday-sourced values', () => {
    const html = eventsListView(
      [
        listing({
          donorName: '<script>alert(1)</script>',
          past: [{ registrationName: 'r', eventName: '<b>Gala</b>', eventDate: '2026-01-01', attended: false }],
        }),
      ],
      'en'
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Gala</b>');
  });

  it('links back to the locale-prefixed portal', () => {
    expect(eventsListView([listing({})], 'es')).toContain('/es/portal');
  });
});

describe('eventsUnavailableView', () => {
  it('explains the feature is not available yet and links back to the portal', () => {
    const html = eventsUnavailableView('en');

    expect(html).toContain('not available yet');
    expect(html).toContain('/en/portal');
  });
});
