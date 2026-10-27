import { describe, it, expect } from 'vitest';
import { validateAttendeeDelivery, idsFromApiUrl } from './validateAttendee';
import { testConfig } from '../test/testConfig';

const config = testConfig();

const delivery = (apiUrl: string, action = 'attendee.updated', configOverrides: Record<string, unknown> = {}) => ({
  api_url: apiUrl,
  config: { action, user_id: '308733706151', webhook_id: '2006537', endpoint_url: 'https://x.example/webhooks/eventbrite/attendee', ...configOverrides },
});

const BASE = 'https://www.eventbriteapi.com/v3';

describe('validateAttendeeDelivery', () => {
  it('takes the event and attendee ids from an attendee URL', () => {
    expect(validateAttendeeDelivery(delivery(`${BASE}/events/1001/attendees/2002/`), config)).toEqual({
      kind: 'process',
      delivery: { kind: 'attendee', eventId: '1001', attendeeId: '2002', action: 'attendee.updated' },
    });
  });

  it('takes the event id from an event URL', () => {
    expect(validateAttendeeDelivery(delivery(`${BASE}/events/1001/`, 'event.published'), config)).toEqual({
      kind: 'process',
      delivery: { kind: 'event', eventId: '1001', action: 'event.published' },
    });
  });

  it('tolerates a missing trailing slash', () => {
    expect(validateAttendeeDelivery(delivery(`${BASE}/events/1001/attendees/2002`), config).kind).toBe('process');
  });

  it('throws on an order URL sent to this route', () => {
    expect(() => validateAttendeeDelivery(delivery(`${BASE}/orders/442719216/`), config)).toThrow('not an event or attendee URL');
  });

  it('ignores order actions on this route, before looking at api_url', () => {
    expect(validateAttendeeDelivery(delivery('garbage', 'order.placed'), config)).toEqual({ kind: 'ignore', reason: 'action "order.placed" is not subscribed' });
  });

  it('throws on a query string, a foreign host, or a path trick', () => {
    expect(() => validateAttendeeDelivery(delivery(`${BASE}/events/1001/?expand=venue`), config)).toThrow('not an event or attendee URL');
    expect(() => validateAttendeeDelivery(delivery('https://evil.example/v3/events/1001/'), config)).toThrow('not an event or attendee URL');
    expect(() => validateAttendeeDelivery(delivery('https://www.eventbriteapi.com.evil.example/v3/events/1001/'), config)).toThrow('not an event or attendee URL');
    expect(() => validateAttendeeDelivery(delivery(`${BASE}/events/1001/../../users/me/`), config)).toThrow('not an event or attendee URL');
    expect(() => validateAttendeeDelivery(delivery(`${BASE}/events/1001/attendees/`), config)).toThrow('not an event or attendee URL');
  });

  it('throws on a non-object body, a missing action, and a missing api_url', () => {
    expect(() => validateAttendeeDelivery('x', config)).toThrow('must be a JSON object');
    expect(() => validateAttendeeDelivery({ api_url: `${BASE}/events/1/`, config: {} }, config)).toThrow('config.action');
    expect(() => validateAttendeeDelivery({ config: { action: 'event.updated' } }, config)).toThrow('api_url');
  });

  it('ignores another organization when organizationId is configured', () => {
    const scoped = testConfig({}, {}, { organizationId: '999' });
    expect(validateAttendeeDelivery(delivery(`${BASE}/events/1001/`, 'event.updated'), scoped).kind).toBe('ignore');
  });

  it('accepts a matching organization and a delivery with no user_id', () => {
    const scoped = testConfig({}, {}, { organizationId: '308733706151' });
    expect(validateAttendeeDelivery(delivery(`${BASE}/events/1001/`, 'event.updated'), scoped).kind).toBe('process');
    const bare = delivery(`${BASE}/events/1001/`, 'event.updated');
    delete (bare.config as Record<string, unknown>).user_id;
    expect(validateAttendeeDelivery(bare, scoped).kind).toBe('process');
  });
});

describe('idsFromApiUrl', () => {
  it('returns null for unparseable input', () => {
    expect(idsFromApiUrl('not a url', BASE)).toBeNull();
  });
});
