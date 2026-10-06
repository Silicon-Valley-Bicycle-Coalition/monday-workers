import { describe, it, expect } from 'vitest';
import { validateDelivery, orderIdFromApiUrl } from './validate';
import { testConfig } from '../test/testConfig';

const config = testConfig();

// Eventbrite's documented delivery: a pointer plus the webhook's config block.
const delivery = (overrides: Record<string, unknown> = {}, configOverrides: Record<string, unknown> = {}) => ({
  api_url: 'https://www.eventbriteapi.com/v3/orders/442719216/',
  config: { action: 'order.placed', user_id: '308733706151', webhook_id: '2006536', endpoint_url: 'https://x.example/webhooks/eventbrite/order', ...configOverrides },
  ...overrides,
});

describe('validateDelivery', () => {
  it('takes the order id and action from a documented delivery, and nothing else', () => {
    expect(validateDelivery(delivery(), config)).toEqual({
      kind: 'process',
      delivery: { orderId: '442719216', action: 'order.placed', organizationId: '308733706151' },
    });
  });

  it.each(['order.updated', 'order.refunded'])('processes %s', (action) => {
    const verdict = validateDelivery(delivery({}, { action }), config);
    expect(verdict.kind).toBe('process');
  });

  it('ignores an action that is not subscribed, before looking at api_url', () => {
    const verdict = validateDelivery(delivery({ api_url: 'garbage' }, { action: 'attendee.updated' }), config);
    expect(verdict).toEqual({ kind: 'ignore', reason: 'action "attendee.updated" is not subscribed' });
  });

  it('ignores a delivery from another organization when organizationId is configured', () => {
    const scoped = testConfig({}, {}, { organizationId: '999' });
    const verdict = validateDelivery(delivery(), scoped);
    expect(verdict.kind).toBe('ignore');
    expect((verdict as { reason: string }).reason).toContain('308733706151');
  });

  it('accepts a matching organization, and a delivery that carries no user_id (the backfill script)', () => {
    const scoped = testConfig({}, {}, { organizationId: '308733706151' });
    expect(validateDelivery(delivery(), scoped).kind).toBe('process');
    const bare = delivery();
    delete (bare.config as Record<string, unknown>).user_id;
    const verdict = validateDelivery(bare, scoped);
    expect(verdict).toEqual({ kind: 'process', delivery: { orderId: '442719216', action: 'order.placed', organizationId: null } });
  });

  it('rejects a non-object body', () => {
    expect(() => validateDelivery('x', config)).toThrow('must be a JSON object');
    expect(() => validateDelivery(null, config)).toThrow('must be a JSON object');
  });

  it('rejects a body without config.action', () => {
    expect(() => validateDelivery({ api_url: 'https://www.eventbriteapi.com/v3/orders/1/' }, config)).toThrow('config.action');
    expect(() => validateDelivery(delivery({}, { action: '' }), config)).toThrow('config.action');
  });

  it('rejects a body without api_url', () => {
    const d = delivery();
    delete (d as Record<string, unknown>).api_url;
    expect(() => validateDelivery(d, config)).toThrow('missing "api_url"');
  });

  it('rejects an api_url that is not an order under the configured API host', () => {
    for (const api_url of [
      'https://www.eventbriteapi.com/v3/users/me/',
      'https://www.eventbriteapi.com.evil.example/v3/orders/1/',
      'https://evil.example/v3/orders/1/',
      'http://www.eventbriteapi.com/v3/orders/1/',
      'https://www.eventbriteapi.com/v3/orders/1/../../users/me/',
      'https://www.eventbriteapi.com/v3/orders/abc/',
      'https://www.eventbriteapi.com/v3/orders/1/?expand=attendees',
    ]) {
      expect(() => validateDelivery(delivery({ api_url }), config), api_url).toThrow('not an order URL');
    }
  });
});

describe('orderIdFromApiUrl', () => {
  const base = 'https://www.eventbriteapi.com/v3';

  it('extracts the id with or without the trailing slash', () => {
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/442719216/', base)).toBe('442719216');
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/442719216', base)).toBe('442719216');
  });

  it('returns null for anything else', () => {
    expect(orderIdFromApiUrl('not a url', base)).toBeNull();
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/', base)).toBeNull();
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/1/attendees/', base)).toBeNull();
    expect(orderIdFromApiUrl('https://user:pw@www.eventbriteapi.com/v3/orders/1/', base)).toBeNull();
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/1/#x', base)).toBeNull();
  });

  it('follows a fork that points eventbrite.apiUrl elsewhere', () => {
    expect(orderIdFromApiUrl('https://mock.example/v3/orders/7/', 'https://mock.example/v3')).toBe('7');
    expect(orderIdFromApiUrl('https://www.eventbriteapi.com/v3/orders/7/', 'https://mock.example/v3')).toBeNull();
  });
});
