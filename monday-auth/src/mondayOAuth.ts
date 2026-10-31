// Monday OAuth 2.1 client: authorize URL, PKCE (S256 only), code exchange, refresh, revoke, and
// a `me` lookup to confirm which user consented. Monday rotates the refresh token on every
// refresh; the caller must store the new one and discard the old.
//
// Request format is from Monday's migration guide
// (https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow): the token and revoke
// endpoints take `Content-Type: application/json` with the client secret in the JSON body
// (client_secret_post), not form-encoded bodies. No thrown message here ever includes a token or the raw response body (a
// server may echo the token back in `error_description`). The exception is fetchMe, which adds
// Monday's error detail with the access token redacted, capped at 300 chars.

const AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';
const TOKEN_URL = 'https://auth.monday.com/oauth_ms/oauth/token';
const REVOKE_URL = 'https://auth.monday.com/oauth_ms/oauth/revoke';
const API_URL = 'https://api.monday.com/v2';
// Same value as monday-backup's MONDAY_API_VERSION; kept local so Workers don't import each other.
const MONDAY_API_VERSION = '2026-07';
const REQUEST_TIMEOUT_MS = 10_000;
// Used only if neither expires_in nor a JWT exp is present (throwing then would lose an
// already-rotated refresh token). Deliberately short: Monday's tokens measured about 24 h (JWT
// exp, 2026-10-30), and guessing low only costs an early refresh.
const DEFAULT_EXPIRES_IN_S = 3600;

export type FetchFn = typeof fetch;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

// The token endpoint answered `invalid_grant`: the refresh token (or code) is dead and only a new
// consent flow recovers. Every other failure is a plain, retryable Error.
export class RefreshRejectedError extends Error {
  constructor() {
    super('monday oauth: token endpoint rejected the grant (invalid_grant)');
    this.name = 'RefreshRejectedError';
  }
}

// The token endpoint rejected the client itself (`invalid_client`: a wrong or rotated client
// secret; `unauthorized_client`: the app may not use this grant, e.g. it was uninstalled). A
// retry can't fix either, so the broker alerts at once; the message is HTTP status plus code only.
export type ClientRejectedCode = 'invalid_client' | 'unauthorized_client';
export class ClientRejectedError extends Error {
  readonly code: ClientRejectedCode;
  constructor(what: string, status: number, code: ClientRejectedCode) {
    super(`monday oauth ${what}: HTTP ${status} ${code}`);
    this.name = 'ClientRejectedError';
    this.code = code;
  }
}

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  subdomain: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    subdomain: opts.subdomain,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// The `exp` claim of a JWT access token, as an ISO string, or null if it isn't a readable JWT.
function jwtExpiry(token: string): string | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof json.exp === 'number' ? new Date(json.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

async function postTokenEndpoint(payload: Record<string, string>, fetchFn: FetchFn, what: string): Promise<TokenResponse> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    if (body.error === 'invalid_grant') throw new RefreshRejectedError();
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw new ClientRejectedError(what, response.status, body.error);
    }
    const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? ` ${body.error}` : '';
    throw new Error(`monday oauth ${what}: HTTP ${response.status}${code}`);
  }
  return body;
}

function toTokens(body: TokenResponse, fallbackRefreshToken: string | null, now: () => Date, what: string): OAuthTokens {
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error(`monday oauth ${what}: response has no access_token`);
  }
  let refreshToken: string;
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') refreshToken = body.refresh_token;
  else if (fallbackRefreshToken !== null) refreshToken = fallbackRefreshToken; // no rotation: the old one stays valid
  else throw new Error(`monday oauth ${what}: response has no refresh_token`);

  const expiresAt =
    typeof body.expires_in === 'number' && body.expires_in > 0
      ? new Date(now().getTime() + body.expires_in * 1000).toISOString()
      : jwtExpiry(body.access_token) ?? new Date(now().getTime() + DEFAULT_EXPIRES_IN_S * 1000).toISOString();
  return { accessToken: body.access_token, refreshToken, expiresAt };
}

export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string; verifier: string },
  fetchFn: FetchFn,
  now: () => Date = () => new Date()
): Promise<OAuthTokens> {
  const body = await postTokenEndpoint(
    {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code_verifier: opts.verifier,
    },
    fetchFn,
    'code exchange'
  );
  return toTokens(body, null, now, 'code exchange');
}

export async function refresh(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchFn: FetchFn,
  now: () => Date = () => new Date()
): Promise<OAuthTokens> {
  const body = await postTokenEndpoint(
    {
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    fetchFn,
    'refresh'
  );
  return toTokens(body, opts.refreshToken, now, 'refresh');
}

export async function revoke(
  opts: { clientId: string; clientSecret: string; token: string; tokenTypeHint?: 'access_token' | 'refresh_token' },
  fetchFn: FetchFn
): Promise<void> {
  const response = await fetchFn(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      token: opts.token,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      ...(opts.tokenTypeHint === undefined ? {} : { token_type_hint: opts.tokenTypeHint }),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`monday oauth revoke: HTTP ${response.status}`);
}

const MAX_DETAIL_CHARS = 300;

// Monday's error detail from a GraphQL `errors` array or a top-level error_message/error_code
// body, with every occurrence of the access token redacted *before* truncating (so a cut can't
// leave a partial token behind).
function errorDetail(json: unknown, accessToken: string): string {
  if (typeof json !== 'object' || json === null) return '';
  const body = json as { errors?: unknown; error_message?: unknown; error_code?: unknown };
  const parts: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') parts.push(v);
  };
  if (Array.isArray(body.errors)) {
    for (const e of body.errors as Array<{ message?: unknown; extensions?: { code?: unknown } } | null>) {
      add(e?.message);
      add(e?.extensions?.code);
    }
  }
  add(body.error_message);
  add(body.error_code);
  let text = parts.join('; ');
  if (accessToken !== '') text = text.split(accessToken).join('[redacted]');
  return text.slice(0, MAX_DETAIL_CHARS);
}

export async function fetchMe(accessToken: string, fetchFn: FetchFn): Promise<{ id: string; name: string }> {
  const response = await fetchFn(API_URL, {
    method: 'POST',
    headers: { Authorization: accessToken, 'API-Version': MONDAY_API_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ me { id name } }' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = errorDetail(json, accessToken);
    throw new Error(`monday me query: HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
  }
  const me = (json as { data?: { me?: { id?: unknown; name?: unknown } } } | undefined)?.data?.me;
  if (me === undefined || me === null || me.id === undefined || me.id === null) {
    const detail = errorDetail(json, accessToken);
    throw new Error(`monday me query: no user in the response${detail === '' ? '' : `: ${detail}`}`);
  }
  return { id: String(me.id), name: typeof me.name === 'string' ? me.name : '' };
}
