import { describe, expect, it } from 'vitest';
import { authorizeUrl, exchangeCode, fetchMe, pkcePair, refresh, RefreshRejectedError, revoke } from './mondayOAuth';

const TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token';

interface Captured {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
}

function fakeFetch(status: number, body: unknown, calls: Captured[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {}, form: new URLSearchParams(typeof init?.body === 'string' ? init.body : String(init?.body ?? '')) });
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
    const form = calls[0]!.form;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toBe('ver');
    expect(form.get('redirect_uri')).toBe('https://cb');
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('sec');
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
    expect(calls[0]!.form.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.form.get('refresh_token')).toBe('old-ref');
    expect(calls[0]!.form.get('client_id')).toBe('cid');
    expect(calls[0]!.form.get('client_secret')).toBe('sec');
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

  it('expiresAt falls back to JWT exp when expires_in is missing', async () => {
    const exp = Date.parse('2026-10-30T12:34:56.000Z') / 1000;
    const result = await refresh(
      { clientId: 'cid', clientSecret: 'sec', refreshToken: 'r' },
      fakeFetch(200, { access_token: jwtWithExp(exp), refresh_token: 'r2' })
    );
    expect(result.expiresAt).toBe('2026-10-30T12:34:56.000Z');
  });

  it('revoke posts the token to oauth_ms/oauth/revoke', async () => {
    const calls: Captured[] = [];
    await revoke({ clientId: 'cid', clientSecret: 'sec', token: 'tok' }, fakeFetch(200, {}, calls));
    expect(calls[0]!.url).toBe('https://auth.monday.com/oauth_ms/oauth/revoke');
    expect(calls[0]!.form.get('token')).toBe('tok');
    expect(calls[0]!.form.get('client_id')).toBe('cid');
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
});
