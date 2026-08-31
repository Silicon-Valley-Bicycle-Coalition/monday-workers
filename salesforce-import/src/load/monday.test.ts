import { describe, it, expect } from 'vitest';
import { MondayClient } from './monday.js';

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
});
