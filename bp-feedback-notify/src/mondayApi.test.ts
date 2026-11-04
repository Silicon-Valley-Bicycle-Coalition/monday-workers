import { afterEach, describe, expect, it, vi } from 'vitest';
import { mondayRequest, tokenProviderFor } from './mondayApi';

const ok = () => new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
const unauthorized = () => new Response(JSON.stringify({ error_message: 'Not Authenticated' }), { status: 401 });

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const authHeader = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  ((fetchMock.mock.calls[call] as [string, RequestInit])[1].headers as Record<string, string>).Authorization;

describe('mondayRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a fixed token bare, as before', async () => {
    const fetchMock = stubFetch(ok());
    expect(await mondayRequest('tok', 'query { me { id } }', {})).toEqual({ ok: 1 });
    expect(authHeader(fetchMock, 0)).toBe('tok');
  });

  it('asks a provider per request', async () => {
    const fetchMock = stubFetch(ok(), ok());
    const provider = vi.fn().mockResolvedValue('tokA');
    await mondayRequest(provider, 'query { me { id } }', {});
    await mondayRequest(provider, 'query { me { id } }', {});
    expect(provider).toHaveBeenCalledTimes(2);
    expect([authHeader(fetchMock, 0), authHeader(fetchMock, 1)]).toEqual(['tokA', 'tokA']);
  });

  it('re-asks once on 401, passing the rejected token', async () => {
    const fetchMock = stubFetch(unauthorized(), ok());
    const provider = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    expect(await mondayRequest(provider, 'query { me { id } }', {})).toEqual({ ok: 1 });
    expect(provider.mock.calls).toEqual([[], ['old']]);
    expect(authHeader(fetchMock, 1)).toBe('new');
  });

  it('a second 401 throws HTTP 401 without a third call', async () => {
    const fetchMock = stubFetch(unauthorized(), unauthorized());
    const provider = vi.fn().mockResolvedValue('dead');
    await expect(mondayRequest(provider, 'query { me { id } }', {})).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a fixed token never retries a 401', async () => {
    const fetchMock = stubFetch(unauthorized(), ok());
    await expect(mondayRequest('tok', 'query { me { id } }', {})).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('tokenProviderFor', () => {
  it('prefers the binding, falls back to the string, throws on neither', async () => {
    const token = vi.fn().mockResolvedValue('fromBinding');
    expect(await tokenProviderFor({ MONDAY_AUTH: { token }, MONDAY_API_TOKEN: 'str' })('bad')).toBe('fromBinding');
    expect(token).toHaveBeenCalledWith('bad');
    expect(await tokenProviderFor({ MONDAY_API_TOKEN: 'str' })()).toBe('str');
    expect(() => tokenProviderFor({})).toThrow(/neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN/);
  });
});
