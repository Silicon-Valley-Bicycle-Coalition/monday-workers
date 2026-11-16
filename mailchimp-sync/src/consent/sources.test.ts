import { describe, it, expect, vi } from 'vitest';
import { ConsentShortReadError, createConsentMonday, readMailchimpStatuses, type GraphQLRequest } from './sources';
import type { ConsentBoard } from '../types';
import type { ConsentWrite } from './plan';

const KEY = 'secret-key-us9';

function mailchimpFetch(passes: { default: { email_address: string; status: string }[]; archived: { email_address: string; status: string }[] }, totals?: { default?: number; archived?: number }) {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa(`anystring:${KEY}`)}`);
    const params = new URL(url).searchParams;
    const archived = params.get('status') === 'archived';
    const all = archived ? passes.archived : passes.default;
    const offset = Number(params.get('offset'));
    const count = Number(params.get('count'));
    const total = (archived ? totals?.archived : totals?.default) ?? all.length;
    return Response.json({ total_items: total, members: all.slice(offset, offset + count) });
  }) as unknown as typeof fetch;
  return { fetchFn, urls };
}

const opts = (fetchFn: typeof fetch, pageSize?: number) => ({ fetchFn, apiBaseUrl: 'https://us9.api.mailchimp.com/3.0', apiKey: KEY, audienceId: 'aud1', pageSize });

describe('readMailchimpStatuses', () => {
  it('reads both passes, archived included', async () => {
    const { fetchFn, urls } = mailchimpFetch({
      default: [{ email_address: 'Pat@Example.org', status: 'subscribed' }, { email_address: 'b@x.org', status: 'cleaned' }],
      archived: [{ email_address: 'c@x.org', status: 'archived' }],
    });
    const statuses = await readMailchimpStatuses(opts(fetchFn));
    expect([...statuses]).toEqual([['pat@example.org', 'subscribed'], ['b@x.org', 'cleaned'], ['c@x.org', 'archived']]);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toContain('/lists/aud1/members?');
      expect(url).toContain('count=1000');
      expect(decodeURIComponent(url)).toContain('fields=total_items,members.email_address,members.status');
    }
    expect(urls[0]).not.toContain('status=');
    expect(urls[1]).toContain('status=archived');
  });

  it('pages by offset until total_items', async () => {
    const members = ['a', 'b', 'c'].map((n) => ({ email_address: `${n}@x.org`, status: 'subscribed' }));
    const { fetchFn, urls } = mailchimpFetch({ default: members, archived: [] });
    const statuses = await readMailchimpStatuses(opts(fetchFn, 2));
    expect(statuses.size).toBe(3);
    expect(urls.filter((u) => !u.includes('status=archived')).map((u) => new URL(u).searchParams.get('offset'))).toEqual(['0', '2']);
  });

  it('throws ConsentShortReadError when a pass reads fewer than total_items', async () => {
    const { fetchFn } = mailchimpFetch({ default: [{ email_address: 'a@x.org', status: 'subscribed' }], archived: [] }, { default: 2 });
    await expect(readMailchimpStatuses(opts(fetchFn))).rejects.toBeInstanceOf(ConsentShortReadError);
  });

  it('throws on a non-2xx page, without the key', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const err = (await readMailchimpStatuses(opts(fetchFn)).then(() => null, (e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('503');
    expect(err.message).not.toContain(KEY);
  });
});

const board: ConsentBoard = { name: 'People', boardId: 7, pairs: [{ emailColumn: 'e', consentColumn: 'k' }] };
const col = (id: string, text: string | null, email?: string) => ({ id, text, ...(email === undefined ? {} : { email }) });

describe('createConsentMonday.readBoard', () => {
  it('pages items with only the configured columns', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const request = (async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (calls.length === 1) {
        return { boards: [{ items_page: { cursor: 'c1', items: [{ id: '1', column_values: [col('e', 'Pat - pat@x.org', 'pat@x.org'), col('k', 'Subscribed')] }] } }] };
      }
      return { next_items_page: { cursor: null, items: [{ id: '2', column_values: [col('e', null, ''), col('k', null)] }] } };
    }) as GraphQLRequest;
    const items = await createConsentMonday(request).readBoard(board);
    expect(items).toEqual([
      { itemId: '1', values: { e: 'pat@x.org', k: 'Subscribed' } },
      { itemId: '2', values: { e: '', k: '' } },
    ]);
    expect(calls[0]!.query).toContain('items_page(limit: 500');
    expect(calls[0]!.query).toContain('... on EmailValue { email }');
    expect(calls[0]!.variables).toMatchObject({ boardId: 7, columnIds: ['e', 'k'] });
    expect(calls[1]!.query).toContain('next_items_page(limit: 500');
    expect(calls[1]!.variables).toMatchObject({ cursor: 'c1', columnIds: ['e', 'k'] });
  });

  it('falls back to text for an email value without an email field', async () => {
    const request = (async () => ({ boards: [{ items_page: { cursor: null, items: [{ id: '1', column_values: [col('e', 'a@x.org'), col('k', '')] }] } }] })) as GraphQLRequest;
    expect((await createConsentMonday(request).readBoard(board))[0]!.values.e).toBe('a@x.org');
  });

  it('readBoard throws when a configured column is missing from the board', async () => {
    const request = (async () => ({ boards: [{ items_page: { cursor: null, items: [{ id: '1', column_values: [col('e', 'a@x.org')] }] } }] })) as GraphQLRequest;
    await expect(createConsentMonday(request).readBoard(board)).rejects.toThrow(/"k"/);
  });

  it('throws when the board is not readable', async () => {
    const request = (async () => ({ boards: [] })) as GraphQLRequest;
    await expect(createConsentMonday(request).readBoard(board)).rejects.toThrow(/7/);
  });
});

const write = (itemId: string, label: ConsentWrite['columnValues'][string] = 'Unsubscribed'): ConsentWrite =>
  ({ boardId: 7, itemId, columnValues: { k: label } });

describe('createConsentMonday.writeConsent', () => {
  it('aliases up to 25 items per mutation', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const request = (async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return {};
    }) as GraphQLRequest;
    const writes = Array.from({ length: 30 }, (_, i) => write(String(i), i === 0 ? '' : 'Cleaned'));
    const result = await createConsentMonday(request).writeConsent(writes);
    expect(result).toEqual({ written: 30, failedItemIds: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query.match(/change_multiple_column_values/g)).toHaveLength(25);
    expect(calls[1]!.query.match(/change_multiple_column_values/g)).toHaveLength(5);
    expect(calls[0]!.variables).toMatchObject({ b0: 7, i0: '0', v0: JSON.stringify({ k: '' }), v1: JSON.stringify({ k: { label: 'Cleaned' } }) });
  });

  it('writeConsent isolates a failed chunk item by item', async () => {
    const request = (async (query: string, variables: Record<string, unknown>) => {
      if ((query.match(/change_multiple_column_values/g) ?? []).length > 1) throw new Error('chunk failed');
      if (variables.i0 === '2') throw new Error('item failed');
      return {};
    }) as GraphQLRequest;
    const result = await createConsentMonday(request).writeConsent([write('1'), write('2'), write('3')]);
    expect(result).toEqual({ written: 2, failedItemIds: ['2'] });
  });
});
