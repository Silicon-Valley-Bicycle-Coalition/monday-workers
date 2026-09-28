import { describe, it, expect } from 'vitest';
import { AmbiguousWriteError, MondayClient } from './monday.js';

const noSleep = async () => {};

function sequence(responses: (() => Response)[]): typeof fetch {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]!()) as typeof fetch;
}

describe('MondayClient', () => {
  it('returns data on success', async () => {
    const c = new MondayClient({ apiUrl: 'https://x', token: 't',
      fetchFn: sequence([() => Response.json({ data: { me: { id: 1 } } })]), sleepFn: noSleep });
    expect(await c.gql<{ me: { id: number } }>('query { me { id } }')).toEqual({ me: { id: 1 } });
  });

  it('retries 429 then succeeds', async () => {
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep,
      fetchFn: sequence([
        () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
        () => Response.json({ data: { ok: true } }),
      ]) });
    expect(await c.gql('query')).toEqual({ ok: true });
  });

  it('retries ComplexityException but throws immediately on other GraphQL errors', async () => {
    const complexity = () => Response.json({ errors: [{ message: 'x', extensions: { code: 'ComplexityException' } }] });
    const c1 = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, maxAttempts: 2,
      fetchFn: sequence([complexity, () => Response.json({ data: { ok: 1 } })]) });
    expect(await c1.gql('q')).toEqual({ ok: 1 });

    const bad = () => Response.json({ errors: [{ message: 'ColumnValueException: bad value' }] });
    const c2 = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn: sequence([bad]) });
    await expect(c2.gql('q')).rejects.toThrow(/ColumnValueException/);
  });

  it('retries the HTTP-200 no-data rate-limit shape then succeeds', async () => {
    // Monday's rate-limit/auth shape: HTTP 200 with error_message/status_code and NO data.
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep,
      fetchFn: sequence([
        () => Response.json({ error_message: 'Rate Limit Exceeded', status_code: 429 }),
        () => Response.json({ data: { ok: true } }),
      ]) });
    expect(await c.gql('query')).toEqual({ ok: true });
  });

  it('throws the server error_message when the no-data shape persists, never returns undefined', async () => {
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, maxAttempts: 2,
      fetchFn: sequence([() => Response.json({ error_message: 'Not Authenticated', status_code: 401 })]) });
    await expect(c.gql('q')).rejects.toThrow(/Not Authenticated.*401/);
  });

  it('gives up after maxAttempts', async () => {
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, maxAttempts: 3,
      fetchFn: sequence([() => new Response('boom', { status: 500 })]) });
    await expect(c.gql('q')).rejects.toThrow(/HTTP 500/);
  });

  it('retries a rejected fetch (network error) for idempotent calls', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      if (calls++ === 0) throw new TypeError('fetch failed: ECONNRESET');
      return Response.json({ data: { ok: true } });
    }) as typeof fetch;
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn });
    expect(await c.gql('q')).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('passes a timeout signal on every request', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Response.json({ data: { ok: true } });
    }) as typeof fetch;
    await new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn }).gql('q');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  describe('idempotent: false (create_item)', () => {
    const ambiguousCases: [string, () => Response | Promise<Response>][] = [
      ['HTTP 5xx', () => new Response('boom', { status: 502 })],
      ['a network error', () => { throw new TypeError('fetch failed'); }],
      ['the no-data shape without a 429 status', () => Response.json({ error_message: 'Internal error', status_code: 500 })],
    ];
    for (const [label, respond] of ambiguousCases) {
      it(`throws AmbiguousWriteError on ${label} instead of retrying (the write may have committed)`, async () => {
        let calls = 0;
        const fetchFn = (async () => { calls++; return respond(); }) as typeof fetch;
        const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn });
        await expect(c.gql('mutation', {}, { idempotent: false })).rejects.toBeInstanceOf(AmbiguousWriteError);
        expect(calls).toBe(1);
      });
    }

    it('still retries responses that prove the request never ran (429, complexity, no-data 429)', async () => {
      const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep,
        fetchFn: sequence([
          () => new Response('rate limited', { status: 429 }),
          () => Response.json({ errors: [{ message: 'x', extensions: { code: 'ComplexityException' } }] }),
          () => Response.json({ error_message: 'Rate Limit Exceeded', status_code: 429 }),
          () => Response.json({ data: { create_item: { id: '1' } } }),
        ]) });
      expect(await c.gql('mutation', {}, { idempotent: false })).toEqual({ create_item: { id: '1' } });
    });
  });

  it('waits retry_in_seconds from a rate-limit or complexity error before retrying', async () => {
    const slept: number[] = [];
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: async (ms) => { slept.push(ms); },
      fetchFn: sequence([
        () => Response.json({ errors: [{ message: 'Complexity budget exhausted',
          extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 17 } }] }),
        () => Response.json({ errors: [{ message: 'Rate limit exceeded',
          extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 5 } }] }),
        () => Response.json({ data: { ok: 1 } }),
      ]) });
    expect(await c.gql('q', {}, { idempotent: false })).toEqual({ ok: 1 });
    expect(slept).toContain(17_000);
    expect(slept).toContain(5_000);
  });

  it('caps an absurd retry_in_seconds so a daily-limit reply cannot stall the run for hours', async () => {
    const slept: number[] = [];
    const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: async (ms) => { slept.push(ms); },
      fetchFn: sequence([
        () => Response.json({ errors: [{ message: 'x', extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 86_400 } }] }),
        () => Response.json({ data: { ok: 1 } }),
      ]) });
    await c.gql('q');
    expect(Math.max(...slept)).toBeLessThanOrEqual(120_000 + 2 ** 1 * 1000 + 500);
  });

  describe('gqlPartial (aliased batch mutations)', () => {
    it('returns per-alias data alongside per-alias errors instead of throwing', async () => {
      const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep,
        fetchFn: sequence([() => Response.json({
          data: { i0: { id: '1' }, i1: null },
          errors: [{ message: 'ColumnValueException', path: ['i1'] }],
        })]) });
      const r = await c.gqlPartial<Record<string, { id: string } | null>>('mutation');
      expect(r.data).toEqual({ i0: { id: '1' }, i1: null });
      expect(r.errors.map((e) => e.path)).toEqual([['i1']]);
    });

    it('retries a whole-request complexity rejection that carries no data at all', async () => {
      let calls = 0;
      const fetchFn = (async () => {
        calls++;
        return calls === 1
          ? Response.json({ errors: [{ message: 'budget', extensions: { code: 'ComplexityException', retry_in_seconds: 1 } }] })
          : Response.json({ data: { i0: { id: '9' } } });
      }) as typeof fetch;
      const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn });
      expect((await c.gqlPartial('mutation')).data).toEqual({ i0: { id: '9' } });
      expect(calls).toBe(2);
    });

    it('does NOT retry a complexity error once any alias has data (the request ran)', async () => {
      let calls = 0;
      const fetchFn = (async () => {
        calls++;
        return Response.json({ data: { i0: { id: '1' }, i1: null },
          errors: [{ message: 'complexity', path: ['i1'], extensions: { code: 'ComplexityException' } }] });
      }) as typeof fetch;
      const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn });
      const r = await c.gqlPartial('mutation');
      expect(calls).toBe(1);
      expect(r.data).toEqual({ i0: { id: '1' }, i1: null });
    });

    it('throws AmbiguousWriteError on a 5xx, never re-sending the batch', async () => {
      let calls = 0;
      const fetchFn = (async () => { calls++; return new Response('boom', { status: 504 }); }) as typeof fetch;
      const c = new MondayClient({ apiUrl: 'https://x', token: 't', sleepFn: noSleep, fetchFn });
      await expect(c.gqlPartial('mutation')).rejects.toBeInstanceOf(AmbiguousWriteError);
      expect(calls).toBe(1);
    });
  });
});
