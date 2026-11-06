import { describe, it, expect, vi } from 'vitest';
import { HttpEventbriteClient } from './client';
import { testOrder } from '../test/testConfig';
import { TerminalError } from '../errors';

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

  it('throws a TerminalError on a 4xx that is about the request itself (#75), but not on 401/403/429', async () => {
    const terminal = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(400, {})));
    await expect(terminal.getOrder('1')).rejects.toBeInstanceOf(TerminalError);
    for (const status of [401, 403, 429, 503]) {
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(status, {})));
      await expect(client.getOrder('1'), String(status)).rejects.not.toBeInstanceOf(TerminalError);
    }
  });

  it('throws on a body that is not an order', async () => {
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(200, { orders: [] })));
    await expect(client.getOrder('1')).rejects.toThrow('unexpected body');
  });

  it('keeps a malformed body out of the error, which is logged and stored, and retries', async () => {
    const res = new Response('<html>call me at 408-555-0188', { status: 200 });
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(res));
    const err = await client.getAttendee('1', '2').catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('eventbrite api: get attendee 1/2 returned an unexpected body');
    expect(err).not.toBeInstanceOf(TerminalError);
  });

  it('refuses a non-numeric order id without making a request', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
    await expect(client.getOrder('../users/me')).rejects.toThrow('non-numeric');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('getEvent', () => {
    it('fetches the event with the venue, organizer and sales status expansions', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { id: '1993885250458', organizer: { name: 'SVBC' } }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

      const event = await client.getEvent('1993885250458');

      expect(event?.organizer?.name).toBe('SVBC');
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://www.eventbriteapi.com/v3/events/1993885250458/?expand=venue,organizer,event_sales_status');
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

    it('keeps answers from the response, with its URL unchanged', async () => {
      const answers = [{ question: 'Home ZIP code', question_id: '1', type: 'text', answer: '95112' }];
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { id: '77', answers }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

      const attendee = await client.getAttendee('1993885250458', '77');

      expect(attendee?.answers).toEqual(answers);
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

  describe('listOrganizationOrders', () => {
    it('follows the continuation token across pages with the status and changed_since filters', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(response(200, { orders: [{ id: '1' }], pagination: { has_more_items: true, continuation: 'abc' } }))
        .mockResolvedValueOnce(response(200, { orders: [{ id: '2' }], pagination: { has_more_items: false } }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);

      const orders = await client.listOrganizationOrders('999', '2026-11-01T13:00:00Z');

      expect(orders.map((o) => o.id)).toEqual(['1', '2']);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://www.eventbriteapi.com/v3/organizations/999/orders/?status=all_not_deleted&changed_since=2026-11-01T13%3A00%3A00Z');
      expect(fetchImpl.mock.calls[1]![0]).toContain('continuation=abc');
      expect(fetchImpl.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
    });

    it('refuses a non-numeric organization id', async () => {
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn());
      await expect(client.listOrganizationOrders('../x', '2026-11-01T13:00:00Z')).rejects.toThrow('non-numeric');
    });

    it('throws on 404, a token error, or a body with no orders array', async () => {
      for (const [status, body, message] of [
        [404, {}, 'HTTP 404'],
        [403, {}, 'EVENTBRITE_PRIVATE_TOKEN'],
        [200, { pagination: {} }, '"orders"'],
      ] as const) {
        const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(status, body)));
        await expect(client.listOrganizationOrders('999', '2026-11-01T13:00:00Z'), String(status)).rejects.toThrow(message);
      }
    });

    it('stops after 20 pages instead of paging forever', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { orders: [], pagination: { has_more_items: true, continuation: 'again' } }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
      await expect(client.listOrganizationOrders('999', '2026-11-01T13:00:00Z')).rejects.toThrow('more than 20 pages');
      expect(fetchImpl).toHaveBeenCalledTimes(20);
    });
  });

  describe('countAttendees', () => {
    const client = (body: unknown) => new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', vi.fn().mockResolvedValue(response(200, body)));

    it('reads the total from one page of the attendee list', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { pagination: { object_count: 2911 }, attendees: [] }));
      expect(await new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl).countAttendees('55')).toBe(2911);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://www.eventbriteapi.com/v3/events/55/attendees/');
    });

    it('refuses a non-numeric event id', async () => {
      await expect(client({}).countAttendees('abc')).rejects.toThrow(/non-numeric/);
    });

    it('throws when the total is missing', async () => {
      await expect(client({ pagination: {} }).countAttendees('55')).rejects.toThrow(/object_count/);
    });
  });

  describe('listMyOrganizationIds', () => {
    it("returns the token's organization ids as strings", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { organizations: [{ id: '4242' }, { id: 7 }] }));
      const client = new HttpEventbriteClient('https://www.eventbriteapi.com/v3', 'tok', fetchImpl);
      expect(await client.listMyOrganizationIds()).toEqual(['4242', '7']);
      expect(fetchImpl.mock.calls[0]![0]).toBe('https://www.eventbriteapi.com/v3/users/me/organizations/');
    });
  });
});
