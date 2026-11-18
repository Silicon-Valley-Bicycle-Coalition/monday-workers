import { describe, it, expect, vi } from 'vitest';
import { HttpMailchimpClient, MailchimpTransientError, MailchimpPermanentError, MailchimpRateLimitError, MailchimpAuthError } from './client';

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
    // anyone to the audience — Mailchimp is the consent system of record (issue GL#28).
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    const result = await client.updateMember('Donor@Example.com', { MTIER: 'Standard' }, ['active-member'], MANAGED_TAGS);

    expect(result).toBe('updated');
    expect(fetchFn).toHaveBeenCalledWith(
      // md5('donor@example.com') === 'b5abe4cfed3adc382b3292a791f6faa3'
      // skip_merge_validation: the audience's required fields (City, County, names) are blank on
      // ~1,800 contacts, and Mailchimp refuses any PATCH to one of them without it.
      'https://us1.api.mailchimp.com/3.0/lists/aud1/members/b5abe4cfed3adc382b3292a791f6faa3?skip_merge_validation=true',
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

  // GL#97: the member's current tags are only needed once the PATCH has found the member, so a
  // caller can pass a reader instead of a list and save a call on every not-in-audience donor.
  it('reads lazily supplied managed tags only after the PATCH finds the member', async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);
    const readManaged = vi.fn(async () => {
      expect(fetchFn).toHaveBeenCalledTimes(1); // the PATCH, and nothing else yet
      return [...MANAGED_TAGS, 'Near: Old'];
    });

    await client.updateMember('a@b.com', {}, ['active-member'], readManaged);

    expect(readManaged).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[1]![1].body as string) as { tags: { name: string; status: string }[] };
    expect(body.tags).toContainEqual({ name: 'Near: Old', status: 'inactive' });
  });

  it('never reads lazily supplied managed tags for a member not in the audience', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);
    const readManaged = vi.fn(async () => MANAGED_TAGS);

    expect(await client.updateMember('nobody@example.com', {}, ['active-member'], readManaged)).toBe('not-in-audience');
    expect(readManaged).not.toHaveBeenCalled();
  });

  it('sets the interests the reader returns after the PATCH, before the tags change', async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);
    const interests = vi.fn(async () => {
      expect(fetchFn).toHaveBeenCalledTimes(1); // the merge-field PATCH only
      return { w: true, r: true };
    });

    await client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS, interests);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [url, init] = fetchFn.mock.calls[1]! as [string, RequestInit];
    expect(url).toContain('/members/');
    expect(url).toContain('skip_merge_validation=true');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ interests: { w: true, r: true } });
    expect(fetchFn.mock.calls[2]![0]).toContain('/tags');
  });

  it('makes no interests call when the reader returns none, or for a member not in the audience', async () => {
    const fetchFn = fakeFetch({ ok: true });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);
    await client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS, async () => ({}));
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const missing = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fakeFetch({ ok: false, status: 404 }));
    const reader = vi.fn(async () => ({ w: true }));
    expect(await missing.updateMember('nobody@example.com', {}, ['active-member'], MANAGED_TAGS, reader)).toBe('not-in-audience');
    expect(reader).not.toHaveBeenCalled();
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

describe('HttpMailchimpClient.getMemberTagNames', () => {
  it('lists the member\'s tag names via the tags endpoint with count=1000', async () => {
    const fetchFn = fakeFetch({ ok: true, json: async () => ({ tags: [{ id: 1, name: 'Near: Old' }, { id: 2, name: 'VIP' }], total_items: 2 }) });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);

    expect(await client.getMemberTagNames('a@b.com')).toEqual(['Near: Old', 'VIP']);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toMatch(/\/lists\/aud1\/members\/[0-9a-f]{32}\/tags\?count=1000$/);
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
  });

  it('returns [] on a 404 (member not in the audience)', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);
    expect(await client.getMemberTagNames('a@b.com')).toEqual([]);
  });

  it('throws the client\'s usual classified errors on other failures', async () => {
    const server = new HttpMailchimpClient('https://x', 'k', 'aud', fakeFetch({ ok: false, status: 503 }));
    await expect(server.getMemberTagNames('a@b.com')).rejects.toBeInstanceOf(MailchimpTransientError);
    const auth = new HttpMailchimpClient('https://x', 'k', 'aud', fakeFetch({ ok: false, status: 401 }));
    await expect(auth.getMemberTagNames('a@b.com')).rejects.toBeInstanceOf(MailchimpAuthError);
    const limited = new HttpMailchimpClient('https://x', 'k', 'aud', fakeFetch({ ok: false, status: 429 }));
    await expect(limited.getMemberTagNames('a@b.com')).rejects.toBeInstanceOf(MailchimpRateLimitError);
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

    const interests = await client.listInterests(['cat1']);

    expect(interests).toEqual([
      { categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' },
      { categoryId: 'cat1', interestId: 'int2', name: 'Welcome Drip' },
    ]);
  });

  it('reads only the configured categories', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ categories: [{ id: 'old' }, { id: 'cat1' }] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ interests: [{ id: 'int1', name: 'Newsletter' }] }) } as Response);
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);

    expect(await client.listInterests(['cat1'])).toEqual([{ categoryId: 'cat1', interestId: 'int1', name: 'Newsletter' }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toContain('/interest-categories/cat1/interests');
  });

  it('throws when a configured category is not in the audience, rather than reading none', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ categories: [{ id: 'cat1' }] }) } as Response);
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key', 'aud1', fetchFn);

    await expect(client.listInterests(['cat1', 'typo'])).rejects.toThrow('interest categories not in the audience: typo');
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
    expect(url).toBe(`${HASH_URL}?skip_merge_validation=true`);
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

  it('classifies a failed status lookup the same way: 429/5xx transient, other 4xx permanent', async () => {
    const transient = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', sequenceFetch({ status: 500 }));
    await expect(transient.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpTransientError);

    const permanent = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', sequenceFetch({ status: 400 }));
    await expect(permanent.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpPermanentError);
  });
});

describe('HttpMailchimpClient.renameMember', () => {
  const BASE = 'https://us1.api.mailchimp.com/3.0/lists/aud1/members';
  const OLD_URL = `${BASE}/ef903182f04f56f4e6ed568d13872f31`;
  const NEW_URL = `${BASE}/15799ec368544c4559fafadc4d3e2a47`;

  it('checks the new address is free, then PATCHes only email_address on the old member', async () => {
    const fetchFn = sequenceFetch({ status: 404 }, { status: 200 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn);

    await expect(client.renameMember('Old@B.com ', 'new@b.com')).resolves.toBe('renamed');

    expect(fetchFn).toHaveBeenNthCalledWith(1, `${NEW_URL}?fields=status`, expect.anything());
    const [url, init] = fetchFn.mock.calls[1]!;
    expect(url).toBe(`${OLD_URL}?skip_merge_validation=true`);
    expect((init as RequestInit).method).toBe('PATCH');
    // Only the address: the member's status (its consent) is never sent, so never changed.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email_address: 'new@b.com' });
  });

  it('returns target-exists without writing when the new address is already a member', async () => {
    const fetchFn = sequenceFetch({ status: 200, json: { status: 'subscribed' } });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', fetchFn);

    await expect(client.renameMember('old@b.com', 'new@b.com')).resolves.toBe('target-exists');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns not-in-audience when the old address is not a member (nothing to rename, nothing created)', async () => {
    const fetchFn = sequenceFetch({ status: 404 }, { status: 404 });
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', fetchFn);

    await expect(client.renameMember('old@b.com', 'new@b.com')).resolves.toBe('not-in-audience');
  });

  it('makes no request when the two addresses are the same member', async () => {
    const fetchFn = vi.fn();
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', fetchFn);

    await expect(client.renameMember('A@B.com', ' a@b.com')).resolves.toBe('target-exists');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws transient on 429/5xx and permanent on other 4xx from the PATCH', async () => {
    const transient = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', sequenceFetch({ status: 404 }, { status: 503 }));
    await expect(transient.renameMember('old@b.com', 'new@b.com')).rejects.toBeInstanceOf(MailchimpTransientError);

    const permanent = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'k', 'aud1', sequenceFetch({ status: 404 }, { status: 400 }));
    await expect(permanent.renameMember('old@b.com', 'new@b.com')).rejects.toBeInstanceOf(MailchimpPermanentError);
  });
});

describe('HttpMailchimpClient auth failures', () => {
  function rejected(status: number) {
    return fakeFetch({ ok: false, status, text: async () => '{"title":"API Key Invalid"}' });
  }

  for (const status of [401, 403]) {
    it(`throws MailchimpAuthError (transient, never permanent) on a ${status} from every write`, async () => {
      const client = new HttpMailchimpClient('https://x', 'secret-key-us1', 'aud', rejected(status));
      for (const call of [
        () => client.updateMember('a@b.com', {}, [], []),
        () => client.unsubscribeMember('a@b.com'),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MailchimpAuthError);
        expect(err).toBeInstanceOf(MailchimpTransientError);
        expect(err).not.toBeInstanceOf(MailchimpPermanentError);
        expect((err as Error).message).toContain('MAILCHIMP_API_KEY');
        expect((err as Error).message).not.toContain('secret-key-us1');
      }
    });

    it(`throws MailchimpAuthError on a ${status} from the tags sync and from reads`, async () => {
      const tags = new HttpMailchimpClient('https://x', 'k', 'aud', sequenceFetch({ status: 200 }, { status }));
      await expect(tags.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS)).rejects.toBeInstanceOf(MailchimpAuthError);

      const reads = new HttpMailchimpClient('https://x', 'k', 'aud', rejected(status));
      await expect(reads.getMemberInterests('a@b.com')).rejects.toBeInstanceOf(MailchimpAuthError);
      await expect(reads.listInterests(['cat1'])).rejects.toBeInstanceOf(MailchimpAuthError);
    });
  }

  it('keeps a 404 from the tags sync permanent', async () => {
    const client = new HttpMailchimpClient('https://x', 'k', 'aud', sequenceFetch({ status: 200 }, { status: 404 }));
    await expect(client.updateMember('a@b.com', {}, ['active-member'], MANAGED_TAGS)).rejects.toBeInstanceOf(MailchimpPermanentError);
  });
});

describe('HttpMailchimpClient rate limiting', () => {
  function rateLimited(headers: Record<string, string> = {}) {
    return vi.fn().mockResolvedValue({
      ok: false, status: 429, headers: new Headers(headers),
      text: async () => 'too many requests', json: async () => ({}),
    } as unknown as Response);
  }

  it('throws MailchimpRateLimitError (still transient) carrying Retry-After seconds', async () => {
    const client = new HttpMailchimpClient('https://x', 'k', 'aud', rateLimited({ 'Retry-After': '30' }));
    const err = await client.updateMember('a@b.com', {}, [], []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailchimpRateLimitError);
    expect(err).toBeInstanceOf(MailchimpTransientError);
    expect((err as MailchimpRateLimitError).retryAfterSeconds).toBe(30);
    expect((err as Error).message).toBe('mailchimp updateMember: HTTP 429: too many requests');
  });

  it('leaves retryAfterSeconds undefined when Mailchimp sends no Retry-After', async () => {
    const client = new HttpMailchimpClient('https://x', 'k', 'aud', rateLimited());
    const err = await client.getMemberInterests('a@b.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailchimpRateLimitError);
    expect((err as MailchimpRateLimitError).retryAfterSeconds).toBeUndefined();
  });

  it('classifies a 429 from listInterests and the unsubscribe lookup as rate-limited', async () => {
    const client = new HttpMailchimpClient('https://x', 'k', 'aud', rateLimited({ 'Retry-After': '5' }));
    await expect(client.listInterests(['cat1'])).rejects.toBeInstanceOf(MailchimpRateLimitError);
    await expect(client.unsubscribeMember('a@b.com')).rejects.toBeInstanceOf(MailchimpRateLimitError);
  });

  it('keeps read failures on other 4xx transient, not permanent', async () => {
    const fetchFn = fakeFetch({ ok: false, status: 403, text: async () => 'forbidden' });
    const client = new HttpMailchimpClient('https://x', 'k', 'aud', fetchFn);
    const err = await client.getMemberInterests('a@b.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailchimpTransientError);
    expect(err).not.toBeInstanceOf(MailchimpRateLimitError);
  });
});

// GL#73: the queues run one message at a time, so a hung Mailchimp call must fail (and be retried)
// rather than stall every message behind it.
describe('HttpMailchimpClient request timeouts', () => {
  it('passes every request a timeout signal, and a hung request rejects with TimeoutError', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(1));
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    );
    const client = new HttpMailchimpClient('https://us1.api.mailchimp.com/3.0', 'key-us1', 'aud1', fetchFn as typeof fetch);

    await expect(client.unsubscribeMember('a@b.com')).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(client.getMemberInterests('a@b.com')).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(client.listInterests(['cat-1'])).rejects.toMatchObject({ name: 'TimeoutError' });

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    for (const [timeoutMs] of timeoutSpy.mock.calls) expect(timeoutMs).toBe(20_000);
    timeoutSpy.mockRestore();
  });
});
