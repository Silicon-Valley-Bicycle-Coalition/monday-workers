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
});
