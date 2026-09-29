import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError, Deadline } from '../deadline';
import { AmbiguousWriteError, MONDAY_API_VERSION, MondayGraphQL } from './graphql';

// Read-path retry behaviour is covered through HttpMondayClient in client.test.ts; this file
// covers what only the restore tool's writes use: `idempotent: false`.

function transport(responses: (Response | Error)[]) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fetchMock);
  return { gql: new MondayGraphQL('https://api.monday.com/v2', 't', { sleepFn: async () => {}, maxAttempts: 4 }), fetchMock };
}

const MUTATION = 'mutation { create_item(board_id: 1, item_name: "x") { id } }';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MondayGraphQL non-idempotent requests', () => {
  it.each([
    ['a 5xx', () => new Response('oops', { status: 502 })],
    ['a network error', () => new TypeError('socket hang up')],
    ['the no-data shape without a 429 status', () => Response.json({ error_message: 'Internal error', status_code: 500 })],
  ])('throws AmbiguousWriteError on %s instead of retrying', async (_label, make) => {
    const { gql, fetchMock } = transport([make()]);
    await expect(gql.request(MUTATION, {}, { idempotent: false })).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries failures that prove the request never ran', async () => {
    const { gql, fetchMock } = transport([
      new Response('rate limited', { status: 429 }),
      Response.json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED' } }] }),
      Response.json({ error_message: 'Rate Limit Exceeded', status_code: 429 }),
      Response.json({ data: { create_item: { id: '1' } } }),
    ]);
    await expect(gql.request(MUTATION, {}, { idempotent: false })).resolves.toEqual({ create_item: { id: '1' } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a 5xx for idempotent requests (the default)', async () => {
    const { gql } = transport([new Response('oops', { status: 502 }), Response.json({ data: { ok: true } })]);
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: true });
  });
});

// Issue #29 review: one call's retries (5 × 60s timeouts + advised waits) could outlast the
// cron's 15-minute wall-time kill. With a deadline, every wait is capped and retrying stops.
describe('MondayGraphQL with a run deadline', () => {
  function clocked(deadlineInMs: number, responses: () => Response) {
    let t = 0;
    const slept: number[] = [];
    const fetchMock = vi.fn(async () => {
      t += 1_000; // each request takes a second
      return responses();
    });
    vi.stubGlobal('fetch', fetchMock);
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', {
      maxAttempts: 10,
      deadline: new Deadline(deadlineInMs, () => t),
      sleepFn: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    return { gql, fetchMock, slept, now: () => t };
  }

  it('stops retrying a persistent 5xx before the deadline instead of exhausting its attempts', async () => {
    const { gql, fetchMock, now } = clocked(10_000, () => new Response('down', { status: 503 }));
    await expect(gql.request('query { ok }', {})).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
    expect(now()).toBeLessThanOrEqual(10_000);
  });

  it('does not honour a Retry-After that would cross the deadline', async () => {
    const { gql, fetchMock, slept } = clocked(30_000, () => new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(gql.request('query { ok }', {})).rejects.toThrow(/wall-time budget exhausted.*HTTP 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('makes no request at all once the deadline has passed', async () => {
    const { gql, fetchMock } = clocked(0, () => Response.json({ data: { ok: true } }));
    await expect(gql.request('query { ok }', {})).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MondayGraphQL (unbounded)', () => {
  it('still retries normally without a deadline', async () => {
    const { gql } = transport([new Response('oops', { status: 502 }), Response.json({ data: { ok: true } })]);
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: true });
  });
});

describe('MondayGraphQL apiVersion option', () => {
  it('sends MONDAY_API_VERSION by default and the apiVersion option when given', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    await new MondayGraphQL('https://api.monday.com/v2', 't').request('query { ok }', {});
    await new MondayGraphQL('https://api.monday.com/v2', 't', { apiVersion: '2026-01' }).request('query { ok }', {});
    const versions = fetchMock.mock.calls.map((call) => new Headers((call as unknown as [string, RequestInit])[1].headers).get('API-Version'));
    expect(versions).toEqual([MONDAY_API_VERSION, '2026-01']);
  });
});
