// The Worker's two Monday calls (the item read in feedbackItem.ts, the status write-back in
// sendStatus.ts) are small enough that it carries no transport copy (CLAUDE.md, #35) — just this
// one POST helper.
//
// The token comes from the monday-auth broker (the MONDAY_AUTH service binding) when bound, else the
// fixed MONDAY_API_TOKEN secret. TokenProvider, MondayTokenSource and tokenProviderFor mirror the
// same names in the other Workers' src/monday/graphql.ts, kept in step by hand like the version pin.

// Yields the token to send. `rejected` is the token Monday just answered 401 to, so a broker can
// mint a fresh one instead of handing the same dead token back.
export type TokenProvider = (rejected?: string) => Promise<string>;

// The shape of the MONDAY_AUTH service binding (the monday-auth broker's entrypoint).
export interface MondayTokenSource {
  token(rejected?: string): Promise<string>;
}

// The binding wins; the fixed MONDAY_API_TOKEN secret is the fallback during the OAuth cutover.
export function tokenProviderFor(env: { MONDAY_AUTH?: MondayTokenSource; MONDAY_API_TOKEN?: string }): TokenProvider {
  const auth = env.MONDAY_AUTH;
  if (auth !== undefined) return (rejected) => auth.token(rejected);
  const fixed = env.MONDAY_API_TOKEN;
  if (fixed !== undefined) return async () => fixed;
  throw new Error('monday auth: neither the MONDAY_AUTH service binding nor MONDAY_API_TOKEN is set');
}

const MONDAY_API_URL = 'https://api.monday.com/v2';
// Explicit pin (#39): Monday serves a deprecated version as the maintenance one, so a stale pin
// drifts silently. Keep this in step with MONDAY_API_VERSION in the other Workers'
// src/monday/graphql.ts by hand.
const MONDAY_API_VERSION = '2026-07';
// Bound every call so a hung Monday API can't hold the webhook (or a waitUntil) indefinitely.
const MONDAY_TIMEOUT_MS = 10_000;

function post(token: string, query: string, variables: Record<string, unknown>): Promise<Response> {
  return fetch(MONDAY_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(MONDAY_TIMEOUT_MS),
    // Monday expects the bare token, no "Bearer " prefix.
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query, variables }),
  });
}

/**
 * POSTs one GraphQL request and returns `data`; throws on any HTTP, GraphQL, or empty-data failure.
 * A provider is asked per request; on a 401 it is asked once more with the rejected token and the
 * request is sent once more (no loop: a second 401 throws). A fixed string token never retries.
 */
export async function mondayRequest<T>(token: string | TokenProvider, query: string, variables: Record<string, unknown>): Promise<T> {
  const tokenFor: TokenProvider = typeof token === 'function' ? token : async () => token;
  const sent = await tokenFor();
  let response = await post(sent, query, variables);
  if (response.status === 401 && typeof token === 'function') {
    response = await post(await tokenFor(sent), query, variables);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json()) as { data?: T; errors?: { message: string }[]; error_message?: string };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  // Monday's rate-limit/auth-failure shape: HTTP 200, no data, no errors array.
  if (!json.data) throw new Error(json.error_message ?? 'response contained no data');
  return json.data;
}
