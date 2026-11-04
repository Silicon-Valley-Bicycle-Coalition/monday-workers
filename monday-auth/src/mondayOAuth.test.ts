import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  ClientRejectedError,
  exchangeCode,
  fetchMe,
  pkcePair,
  refresh,
  RefreshRejectedError,
  revoke,
} from './mondayOAuth';

const TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token';

interface Captured {
  url: string;
  init: RequestInit;
  json: Record<string, unknown>;
}

function fakeFetch(status: number, body: unknown, calls: Captured[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {}, json: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function jwtWithExp(exp: number): string {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ exp, sub: '1' }))}.sig`;
}

describe('mondayOAuth', () => {
  it('authorizeUrl pins subdomain, S256 and space-joined scopes', () => {
    const url = new URL(
      authorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://auth.example/oauth/callback',
        scopes: ['boards:read', 'users:read'],
        state: 'st',
        codeChallenge: 'chal',
        subdomain: 'bikesiliconvalley',
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.monday.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://auth.example/oauth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('boards:read users:read');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('subdomain')).toBe('bikesiliconvalley');
  });

  it('pkcePair returns a base64url verifier and its SHA-256 challenge', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
    expect((await pkcePair()).verifier).not.toBe(verifier);
  });

  it('exchangeCode posts code_verifier and grant_type authorization_code to oauth_ms/oauth/token', async () => {
    const calls: Captured[] = [];
    const now = new Date('2026-10-30T10:00:00.000Z');
    const result = await exchangeCode(
      { clientId: 'cid', clientSecret: 'sec', code: 'the-code', redirectUri: 'https://cb', verifier: 'ver' },
      fakeFetch(200, { access_token: 'acc', refresh_token: 'ref', expires_in: 3600, token_type: 'Bearer' }, calls),
      () => now
    );
    expect(result).toEqual({ accessToken: 'acc', refreshToken: 'ref', expiresAt: '2026-10-30T11:00:00.000Z' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TOKEN_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
    expect(calls[0]!.json).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      client_secret: 'sec',
      code: 'the-code',
      redirect_uri: 'https://cb',
      code_verifier: 'ver',
    });
  });

  it('refresh returns the rotated refresh token', async () => {
    const calls: Captured[] = [];
    const now = new Date('2026-10-30T10:00:00.000Z');
    const result = await refresh(
      { clientId: 'cid', clientSecret: 'sec', refreshToken: 'old-ref' },
      fakeFetch(200, { access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 3600 }, calls),
      () => now
    );
    expect(result).toEqual({ accessToken: 'new-acc', refreshToken: 'new-ref', expiresAt: '2026-10-30T11:00:00.000Z' });
    expect(calls[0]!.url).toBe(TOKEN_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
    expect(calls[0]!.json).toEqual({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'sec', refresh_token: 'old-ref' });
  });

  it('invalid_grant throws RefreshRejectedError', async () => {
    const p = refresh(
      { clientId: 'cid', clientSecret: 'sec', refreshToken: 'old-ref' },
      fakeFetch(400, { error: 'invalid_grant', error_description: 'token old-ref is revoked' })
    );
    await expect(p).rejects.toBeInstanceOf(RefreshRejectedError);
    await expect(p).rejects.not.toThrow(/old-ref/);
  });

  it('any other token-endpoint failure throws a plain Error without the token', async () => {
    const p = refresh({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'old-ref' }, fakeFetch(503, { error: 'server_error' }));
    await expect(p).rejects.toThrow(/503/);
    await expect(p).rejects.not.toBeInstanceOf(RefreshRejectedError);
    await expect(p).rejects.not.toThrow(/old-ref/);
  });

  it('invalid_client and unauthorized_client throw ClientRejectedError with the code, never the secret or token', async () => {
    for (const [status, code] of [
      [401, 'invalid_client'],
      [400, 'unauthorized_client'],
    ] as const) {
      const p = refresh(
        { clientId: 'cid', clientSecret: 'sec-VALUE', refreshToken: 'old-ref' },
        fakeFetch(status, { error: code, error_description: 'client sec-VALUE / token old-ref not allowed' })
      );
      await expect(p).rejects.toBeInstanceOf(ClientRejectedError);
      await expect(p).rejects.toMatchObject({ code });
      await expect(p).rejects.toThrow(`monday oauth refresh: HTTP ${status} ${code}`);
      await expect(p).rejects.not.toThrow(/sec-VALUE|old-ref/);
      await expect(p).rejects.not.toBeInstanceOf(RefreshRejectedError);
    }
  });

  it('expiresAt falls back to JWT exp when expires_in is missing', async () => {
    const exp = Date.parse('2026-10-30T12:34:56.000Z') / 1000;
    const result = await refresh(
      { clientId: 'cid', clientSecret: 'sec', refreshToken: 'r' },
      fakeFetch(200, { access_token: jwtWithExp(exp), refresh_token: 'r2' })
    );
    expect(result.expiresAt).toBe('2026-10-30T12:34:56.000Z');
  });

  it('revoke posts a JSON body to oauth_ms/oauth/revoke', async () => {
    const calls: Captured[] = [];
    await revoke({ clientId: 'cid', clientSecret: 'sec', token: 'tok' }, fakeFetch(200, { success: true }, calls));
    expect(calls[0]!.url).toBe('https://auth.monday.com/oauth_ms/oauth/revoke');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
    expect(calls[0]!.json).toEqual({ token: 'tok', client_id: 'cid', client_secret: 'sec' });
  });

  it('revoke sends token_type_hint when given', async () => {
    const calls: Captured[] = [];
    await revoke({ clientId: 'cid', clientSecret: 'sec', token: 'tok', tokenTypeHint: 'refresh_token' }, fakeFetch(200, { success: true }, calls));
    expect(calls[0]!.json).toEqual({ token: 'tok', client_id: 'cid', client_secret: 'sec', token_type_hint: 'refresh_token' });
  });

  it('revoke failure throws without the token or response body', async () => {
    const p = revoke({ clientId: 'cid', clientSecret: 'sec', token: 'tok-secret' }, fakeFetch(400, { error: 'invalid_request', error_description: 'tok-secret' }));
    await expect(p).rejects.toThrow(/400/);
    await expect(p).rejects.not.toThrow(/tok-secret/);
  });

  it('fetchMe sends the bare token and API-Version, and returns id as a string', async () => {
    const calls: Captured[] = [];
    const me = await fetchMe('acc', fakeFetch(200, { data: { me: { id: 117112617, name: 'Integrations' } } }, calls));
    expect(me).toEqual({ id: '117112617', name: 'Integrations' });
    expect(calls[0]!.url).toBe('https://api.monday.com/v2');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('Authorization')).toBe('acc');
    expect(headers.get('API-Version')).toBe('2026-07');
  });

  it('fetchMe says why when GraphQL returns errors (scope problem)', async () => {
    const body = { errors: [{ message: 'Missing required scope me:read', extensions: { code: 'MissingScope' } }] };
    await expect(fetchMe('acc', fakeFetch(200, body))).rejects.toThrow(
      /^monday me query:.*Missing required scope me:read.*MissingScope/
    );
  });

  it('fetchMe never puts the access token in its error, even when Monday echoes it', async () => {
    const token = 'secret-token-abc123';
    const body = { errors: [{ message: `Invalid token ${token} supplied`, extensions: { code: `bad-${token}` } }] };
    const err = await fetchMe(token, fakeFetch(200, body)).catch((e: Error) => e);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain(token);
  });

  it('fetchMe includes HTTP status and the JSON error detail on a non-ok response', async () => {
    const body = { error_message: 'Not Authenticated', error_code: 'UserUnauthorizedException' };
    await expect(fetchMe('acc', fakeFetch(401, body))).rejects.toThrow(
      /monday me query: HTTP 401.*Not Authenticated.*UserUnauthorizedException/
    );
  });

  it('fetchMe truncates long detail to 300 characters after redacting', async () => {
    const err = await fetchMe('acc', fakeFetch(200, { errors: [{ message: 'x'.repeat(1000) }] })).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(400);
  });
});
