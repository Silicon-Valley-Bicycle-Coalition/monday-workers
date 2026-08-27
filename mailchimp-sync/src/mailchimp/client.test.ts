import { describe, it, expect, vi } from 'vitest';
import { HttpMailchimpClient, MailchimpTransientError, MailchimpPermanentError } from './client';

function fakeFetch(response: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: response.json ?? (async () => ({})),
    text: response.text ?? (async () => ''),
  } as Response);
}

describe('HttpMailchimpClient.upsertMember', () => {
  it('PUTs the member keyed by the MD5 hash of the lowercased email', async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await client.upsertMember('Donor@Example.com', { MTIER: 'Standard' }, ['active-member']);

    expect(fetchFn).toHaveBeenCalledWith(
      // md5('donor@example.com') === 'b5abe4cfed3adc382b3292a791f6faa3'
      'https://us1.api.mailchimp.com/3.0/lists/aud1/members/b5abe4cfed3adc382b3292a791f6faa3',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          email_address: 'Donor@Example.com',
          status_if_new: 'subscribed',
          merge_fields: { MTIER: 'Standard' },
          tags: ['active-member'],
        }),
      }),
    );
  });

  it('throws MailchimpTransientError on a 429', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 429, text: async () => 'rate limited' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('a@b.com', {}, [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpTransientError on a 500', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('a@b.com', {}, [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpPermanentError on a 400', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, text: async () => 'invalid email' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.upsertMember('not-an-email', {}, [])).rejects.toThrow(MailchimpPermanentError);
  });
});

describe('HttpMailchimpClient.getMemberInterests', () => {
  it('returns null on a 404 (contact not yet in the audience)', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    expect(await client.getMemberInterests('a@b.com')).toBeNull();
  });

  it('returns the interests map on success', async () => {
    const fetchFn = fakeFetch({
      ok: true,
      json: async () => ({ status: 'subscribed', interests: { int1: true, int2: false } }),
    });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    expect(await client.getMemberInterests('a@b.com')).toEqual({
      status: 'subscribed',
      interests: { int1: true, int2: false },
    });
  });
});

describe('HttpMailchimpClient.listInterests', () => {
  it('flattens every category into one array of interests', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ categories: [{ id: 'cat1' }] }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ interests: [{ id: 'int1', name: 'Newsletter' }, { id: 'int2', name: 'Welcome Drip' }] }),
      } as Response);
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);

    const interests = await client.listInterests();

    expect(interests).toEqual([
      { categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' },
      { categoryId: 'cat1', interestId: 'int2', name: 'Welcome Drip' },
    ]);
  });
});
