import { describe, it, expect, vi } from 'vitest';
import { HttpEventbriteClient } from './client';
import { testOrder } from '../test/testConfig';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('HttpEventbriteClient', () => {
  it('fetches the order with the bearer token and the event expansion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, testOrder()));
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

    const order = await client.getOrder('442719216');

    expect(order?.id).toBe('442719216');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://www.eventbriteapi.com/v3/orders/442719216/?expand=event');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null on 404', async () => {
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(404, { error: 'NOT_FOUND' })));
    expect(await client.getOrder('1')).toBeNull();
  });

  it('throws a token-naming error on 401/403', async () => {
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(401, {})));
    await expect(client.getOrder('1')).rejects.toThrow('EVENTBRITE_PRIVATE_TOKEN');
  });

  it('throws on 429 and 5xx so the queue retries', async () => {
    for (const status of [429, 500, 503]) {
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(status, {})));
      await expect(client.getOrder('1'), String(status)).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it('throws on a body that is not an order', async () => {
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(200, { orders: [] })));
    await expect(client.getOrder('1')).rejects.toThrow('unexpected body');
  });

  it('refuses a non-numeric order id without making a request', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
    await expect(client.getOrder('../users/me')).rejects.toThrow('non-numeric');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('getEvent', () => {
    it('fetches the event with the venue and organizer expansions', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { id: '1993885250458', organizer: { name: 'SVBC' } }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

      const event = await client.getEvent('1993885250458');

      expect(event?.organizer?.name).toBe('SVBC');
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://www.eventbriteapi.com/v3/events/1993885250458/?expand=venue,organizer');
      expect(init.headers.Authorization).toBe('Bearer tok');
    });

    it('returns null on 404', async () => {
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(404, {})));
      expect(await client.getEvent('1')).toBeNull();
    });

    it('refuses a non-numeric id and names the token on 401', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(401, {}));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
      await expect(client.getEvent('../x')).rejects.toThrow('non-numeric');
      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(client.getEvent('1')).rejects.toThrow('EVENTBRITE_PRIVATE_TOKEN');
    });
  });

  describe('getAttendee', () => {
    it('fetches the attendee under its event', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { id: '77', cancelled: false }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

      const attendee = await client.getAttendee('1993885250458', '77');

      expect(attendee?.id).toBe('77');
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://www.eventbriteapi.com/v3/events/1993885250458/attendees/77/');
    });

    it('throws on a non-numeric id of either kind, without a request', async () => {
      const fetchImpl = vi.fn();
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
      await expect(client.getAttendee('1', 'x')).rejects.toThrow('non-numeric');
      await expect(client.getAttendee('x', '1')).rejects.toThrow('non-numeric');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns null on 404 and throws on 5xx', async () => {
      const notFound = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(404, {})));
      expect(await notFound.getAttendee('1', '2')).toBeNull();
      const down = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(503, {})));
      await expect(down.getAttendee('1', '2')).rejects.toThrow('HTTP 503');
    });
  });
});
