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

const MANAGED_TAGS = ['active-member', 'lapsed-member', 'lifetime-member', 'has-donated'];

describe('HttpMailchimpClient.updateMember', () => {
  // Must run before any other test in this file calls updateMember: the log guard
  // (`sinkLogged`) is module-scope, so it is only still `false` on the first call.
  it('logs the sandbox outbound sink once per isolate, not on the second call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS);
    await client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({
      sandboxOutbound: 'mailchimp',
      audienceId: 'aud1',
      apiBaseUrl: 'https://us1.api.mailchimp.com/3.0',
    });

    logSpy.mockRestore();
  });

  it('PATCHes only the merge fields of the member keyed by the MD5 hash of the lowercased email', async () => {
    // PATCH, never PUT: a PUT creates missing members, and this Worker must never add
    // anyone to the audience — Mailchimp is the consent system of record (issue #28).
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    const result = await client.updateMember('Donor@Example.com', { MTIER: 'Standard' }, ['active-member'], MANAGED_TAGS);

    expect(result).toBe('updated');
    expect(fetchFn).toHaveBeenCalledWith(
      // md5('donor@example.com') === 'b5abe4cfed3adc382b3292a791f6faa3'
      'https://us1.api.mailchimp.com/3.0/lists/aud1/members/b5abe4cfed3adc382b3292a791f6faa3',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ merge_fields: { MTIER: 'Standard' } }),
      }),
    );
  });

  it('returns not-in-audience on a 404 and never creates the member or touches tags', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 404, text: async () => 'Resource Not Found' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    const result = await client.updateMember('nobody@example.com', { MTIER: 'Standard' }, ['active-member'], MANAGED_TAGS);

    expect(result).toBe('not-in-audience');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));
  });

  it('POSTs the desired tags as active and the other managed tags as inactive after the PATCH', async () => {
    // Member PATCH bodies can't change an existing member's tags, so they must be
    // synced via the tags endpoint every time.
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await client.updateMember('Donor@Example.com', {}, ['lapsed-member', 'has-donated'], MANAGED_TAGS);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://us1.api.mailchimp.com/3.0/lists/aud1/members/b5abe4cfed3adc382b3292a791f6faa3/tags',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          tags: [
            { name: 'lapsed-member', status: 'active' },
            { name: 'has-donated', status: 'active' },
            { name: 'active-member', status: 'inactive' },
            { name: 'lifetime-member', status: 'inactive' },
          ],
        }),
      }),
    );
  });

  it('does not POST tags when the PATCH fails', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, text: async () => 'invalid email' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS)).rejects.toThrow(MailchimpPermanentError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws MailchimpTransientError when the tags POST fails with a 500', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}), text: async () => 'server error' } as Response);
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS)).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpTransientError on a 429', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 429, text: async () => 'rate limited' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.updateMember('a@b.com', {}, [], [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpTransientError on a 500', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 500, text: async () => 'server error' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.updateMember('a@b.com', {}, [], [])).rejects.toThrow(MailchimpTransientError);
  });

  it('throws MailchimpPermanentError on a 400', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 400, text: async () => 'invalid email' });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    await expect(client.updateMember('not-an-email', {}, [], [])).rejects.toThrow(MailchimpPermanentError);
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

function sequenceFetch(...responses: { status: number; json?: unknown }[]) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    } as Response);
  }
  return fn;
}

describe('HttpMailchimpClient.unsubscribeMember', () => {
  const HASH_URL = 'https://us1.api.mailchimp.com/3.0/lists/aud1/members/357a20e8c56e69d6f9734d23ef9517e8';

  it('PATCHes status to unsubscribed for a subscribed member', async () => {
    const fetchFn = sequenceFetch({ status: 200, json: { status: 'subscribed' } }, { status: 200 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await expect(client.unsubscribeMember('A@B.com ')).resolves.toBe('unsubscribed');

    expect(fetchFn).toHaveBeenNthCalledWith(1, `${HASH_URL}?fields=status`, expect.anything());
    const [url, init] = fetchFn.mock.calls[1]!;
    expect(url).toBe(HASH_URL);
    expect((init as RequestInit).method).toBe('PATCH');
    // Only the status — never merge fields or anything that could re-subscribe.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: 'unsubscribed' });
  });

  it('returns not-in-audience without writing when the address is not a member', async () => {
    const fetchFn = sequenceFetch({ status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await expect(client.unsubscribeMember('a@b.com')).resolves.toBe('not-in-audience');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(['unsubscribed', 'cleaned'])('returns already-unsubscribed without writing when the member is %s', async (status) => {
    // Mailchimp rejects a status change on a cleaned address; an unsubscribed one needs nothing.
    const fetchFn = sequenceFetch({ status: 200, json: { status } });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await expect(client.unsubscribeMember('a@b.com')).resolves.toBe('already-unsubscribed');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws transient on 429/5xx and permanent on other 4xx from the PATCH', async () => {
    const transient = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1',
      sequenceFetch({ status: 200, json: { status: 'subscribed' } }, { status: 503 }));
    await expect(transient.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpTransientError);

    const permanent = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1',
      sequenceFetch({ status: 200, json: { status: 'pending' } }, { status: 400 }));
    await expect(permanent.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpPermanentError);
  });

  it('throws transient when the status lookup fails', async () => {
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', sequenceFetch({ status: 500 }));
    await expect(client.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpTransientError);
  });
});
