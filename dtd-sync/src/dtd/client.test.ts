import { describe, it, expect, vi } from 'vitest';
import { DtdClient, DtdAuthError, DtdApiError } from './client';
import type { DtdRegistration } from './types';

const BASE = 'https://dtd.example.org/api/v1/';
const KEY = 'test-private-key';
const PUBLIC = 'test-public-key';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchFn: typeof fetch) {
  return new DtdClient(BASE, KEY, PUBLIC, fetchFn);
}

describe('DtdClient.getUpdatedDonations', () => {
  it('sends since, to and key as query params', async () => {
    const fetchFn = vi.fn(async () => json([]));
    await client(fetchFn as unknown as typeof fetch).getUpdatedDonations('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z');
    const url = new URL(String((fetchFn.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe('https://dtd.example.org/api/v1/get_updated_donations');
    expect(url.searchParams.get('since')).toBe('2026-11-01T00:00:00Z');
    expect(url.searchParams.get('to')).toBe('2026-11-02T00:00:00Z');
    expect(url.searchParams.get('key')).toBe(KEY);
  });

  it('coerces a numeric donation_identifier to string', async () => {
    const fetchFn = async () => json([{ donation_identifier: 12345678, source: 'funraise', matched_amount: null }]);
    const [d] = await client(fetchFn as unknown as typeof fetch).getUpdatedDonations('a', 'b');
    expect(d!.donation_identifier).toBe('12345678');
    expect(d!.donor_email).toBeNull();
  });

  it('auth failure raises DtdAuthError without the key in the message', async () => {
    for (const status of [401, 403]) {
      const error = await client((async () => json({}, status)) as unknown as typeof fetch)
        .getUpdatedDonations('a', 'b').catch((e) => e);
      expect(error).toBeInstanceOf(DtdAuthError);
      expect(error.message).not.toContain(KEY);
      expect(String(error.stack)).not.toContain(KEY);
    }
  });

  it('5xx raises DtdApiError with status, url redacted to path only', async () => {
    const error = await client((async () => json({}, 503)) as unknown as typeof fetch)
      .getUpdatedDonations('a', 'b').catch((e) => e);
    expect(error).toBeInstanceOf(DtdApiError);
    expect(error.status).toBe(503);
    expect(error.message).toContain('/api/v1/get_updated_donations');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('key=');
  });

  it('rejects a non-array response without leaking the key', async () => {
    const error = await client((async () => json({ error: 'x' })) as unknown as typeof fetch)
      .getUpdatedDonations('a', 'b').catch((e) => e);
    expect(error).toBeInstanceOf(DtdApiError);
    expect(error.message).not.toContain(KEY);
  });

  it('wraps a network failure without the key in the message', async () => {
    const fetchFn = async (input: RequestInfo | URL) => { throw new TypeError(`failed ${String(input)}`); };
    const error = await client(fetchFn as unknown as typeof fetch).getUpdatedDonations('a', 'b').catch((e) => e);
    expect(error).toBeInstanceOf(DtdApiError);
    expect(error.message).not.toContain(KEY);
    expect(String(error.stack)).not.toContain(KEY);
  });
});

describe('DtdClient.registerDonation', () => {
  const body: DtdRegistration = {
    campaign: 'Test', donation_identifier: '1', donation_amount: 25, donation_datetime: '2026-11-01T00:00:00Z',
    donor_first_name: 'Pat', donor_last_name: 'Example', donor_email: 'pat@example.org',
  };

  it('POSTs JSON with key in query', async () => {
    const fetchFn = vi.fn(async () => json({}));
    await client(fetchFn as unknown as typeof fetch).registerDonation(body);
    const [input, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(String(input));
    expect(url.pathname).toBe('/api/v1/register_donation');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('registerDonation body carries the public key, never the private key', async () => {
    const fetchFn = vi.fn(async () => json({}));
    await client(fetchFn as unknown as typeof fetch).registerDonation(body);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = JSON.parse(String(init.body));
    expect(sent['360matchpro_public_key']).toBe(PUBLIC);
    expect(sent.donation_identifier).toBe('1');
    expect(String(init.body)).not.toContain(KEY);
  });

  it('raises DtdAuthError on 401 and DtdApiError on 500', async () => {
    await expect(client((async () => json({}, 401)) as unknown as typeof fetch).registerDonation(body)).rejects.toBeInstanceOf(DtdAuthError);
    const error = await client((async () => json({}, 500)) as unknown as typeof fetch).registerDonation(body).catch((e) => e);
    expect(error).toBeInstanceOf(DtdApiError);
    expect(error.status).toBe(500);
  });
});
