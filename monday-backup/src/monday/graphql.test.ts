import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExhaustedError, Deadline } from '../deadline';
import { AmbiguousWriteError, MONDAY_API_VERSION, MondayApiError, MondayGraphQL, tokenProviderFor } from './graphql';

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

describe('MondayGraphQL typed errors', () => {
  it('fails fast on the daily limit, carrying its code, without retrying', async () => {
    const { gql, fetchMock } = transport([
      Response.json({ errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED' } }] }),
    ]);
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MondayApiError);
    expect(err).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', httpStatus: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the last retry hint and status once attempts are exhausted', async () => {
    const limited = () =>
      Response.json({ errors: [{ message: 'Rate limit', extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 42 } }] }, { status: 429 });
    const { gql } = transport([limited(), limited(), limited(), limited()]);
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MondayApiError);
    expect(err).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 42, httpStatus: 429 });
    expect((err as Error).message).toMatch(/exhausted 4 attempts — last error: HTTP 429: Rate limit/);
  });

  it('reads the legacy shape: error_code and "reset in N seconds"', async () => {
    const legacy = () => Response.json({ error_message: 'Complexity budget exhausted, reset in 13 seconds', error_code: 'ComplexityException', status_code: 429 });
    const { gql } = transport([legacy(), legacy(), legacy(), legacy()]);
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ComplexityException', retryAfterSeconds: 13, httpStatus: 429 });
  });

  it('takes the hint from a Retry-After header when the body has none', async () => {
    const { gql } = transport(Array.from({ length: 4 }, () => new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } })));
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryAfterSeconds: 7, httpStatus: 429 });
  });

  it('throws a non-retryable 4xx at once with its status and body', async () => {
    const { gql, fetchMock } = transport([new Response('Not Authenticated', { status: 401 })]);
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 401, message: 'monday API: HTTP 401: Not Authenticated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes AmbiguousWriteError a MondayApiError too', async () => {
    const { gql } = transport([new Response('oops', { status: 502 })]);
    const err = await gql.request(MUTATION, {}, { idempotent: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousWriteError);
    expect(err).toBeInstanceOf(MondayApiError);
    expect(err).toMatchObject({ httpStatus: 502 });
  });
});

describe('MondayGraphQL with a single attempt', () => {
  it('reports the failure itself, with its details, rather than an "exhausted" wrapper', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 9 } }] }),
    );
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn, maxAttempts: 1 });
    const err = await gql.request('query { ok }', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'monday API: Complexity budget exhausted', code: 'COMPLEXITY_BUDGET_EXHAUSTED', retryAfterSeconds: 9 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('names a request timeout rather than reporting a generic network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn, maxAttempts: 1, requestTimeoutMs: 15_000 });
    await expect(gql.request('query { ok }', {})).rejects.toThrow('monday API: request timed out after 15000ms');
  });

  it('does not echo a JSON error body that carries no message', async () => {
    const fetchFn = vi.fn(async () => Response.json({}, { status: 500 }));
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn, maxAttempts: 1 });
    await expect(gql.request('query { ok }', {})).rejects.toThrow(/^monday API: HTTP 500$/);
  });
});

describe('MondayGraphQL unreadable response bodies', () => {
  const truncated = () => new Response('{"data": {"create_item": {"id"', { status: 200 });

  it('treats a truncated 200 body on a write as possibly committed', async () => {
    const fetchFn = vi.fn(async () => truncated());
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn, sleepFn: async () => {} });
    const err = await gql.request(MUTATION, {}, { idempotent: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousWriteError);
    expect((err as Error).message).toMatch(/unreadable response body/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a truncated body on a read', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(truncated()).mockResolvedValueOnce(Response.json({ data: { ok: true } }));
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn, sleepFn: async () => {} });
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('MondayGraphQL fetchFn option', () => {
  it('uses an injected fetch instead of the global one', async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: { ok: true } }));
    const gql = new MondayGraphQL('https://api.monday.com/v2', 't', { fetchFn });
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

describe('MondayGraphQL token provider', () => {
  const ok = () => new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
  const unauthorized = () => new Response('Not Authenticated', { status: 401 });
  function withProvider(provider: (rejected?: string) => Promise<string>, responses: Response[], maxAttempts = 4) {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(r);
    vi.stubGlobal('fetch', fetchMock);
    const gql = new MondayGraphQL('https://api.monday.com/v2', provider, { sleepFn: async () => {}, maxAttempts });
    return { gql, fetchMock };
  }
  const authOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    (fetchMock.mock.calls[call]![1] as RequestInit & { headers: Record<string, string> }).headers.Authorization;

  it('calls the provider per request', async () => {
    const provider = vi.fn().mockResolvedValue('tokA');
    const { gql, fetchMock } = withProvider(provider, [ok(), ok()]);
    await gql.request('query { ok }', {});
    await gql.request('query { ok }', {});
    expect(provider).toHaveBeenCalledTimes(2);
    expect(authOf(fetchMock, 0)).toBe('tokA');
    expect(authOf(fetchMock, 1)).toBe('tokA');
  });

  it('asks the provider again once after a 401, passing the rejected token', async () => {
    const provider = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    const { gql, fetchMock } = withProvider(provider, [unauthorized(), ok()]);
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: 1 });
    expect(provider.mock.calls).toEqual([[], ['old']]);
    expect(authOf(fetchMock, 1)).toBe('new');
  });

  it('a second 401 throws MondayApiError httpStatus 401 without a third call', async () => {
    const provider = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    const { gql, fetchMock } = withProvider(provider, [unauthorized(), unauthorized()]);
    await expect(gql.request('query { ok }', {})).rejects.toMatchObject({ httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a string token never retries a 401', async () => {
    const { gql, fetchMock } = transport([unauthorized(), ok()]);
    await expect(gql.request('query { ok }', {})).rejects.toMatchObject({ httpStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 retry does not count against maxAttempts', async () => {
    const provider = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    const { gql } = withProvider(provider, [unauthorized(), ok()], 1);
    await expect(gql.request('query { ok }', {})).resolves.toEqual({ ok: 1 });
  });

  it('tokenProviderFor prefers the binding, falls back to the string, throws on neither', async () => {
    const token = vi.fn().mockResolvedValue('fromBinding');
    expect(await tokenProviderFor({ MONDAY_AUTH: { token }, MONDAY_API_TOKEN: 'str' })('bad')).toBe('fromBinding');
    expect(token).toHaveBeenCalledWith('bad');
    expect(await tokenProviderFor({ MONDAY_API_TOKEN: 'str' })()).toBe('str');
    expect(() => tokenProviderFor({})).toThrow(/neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN/);
  });

  it('tokenProviderFor treats an empty MONDAY_API_TOKEN as unset', async () => {
    // An empty secret would otherwise send an empty Authorization header.
    expect(() => tokenProviderFor({ MONDAY_API_TOKEN: '' })).toThrow(/neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN/);
    const token = async () => 'fromBinding';
    expect(await tokenProviderFor({ MONDAY_AUTH: { token }, MONDAY_API_TOKEN: '' })()).toBe('fromBinding');
  });
});
