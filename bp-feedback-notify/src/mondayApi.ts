// The Worker's two Monday calls (the item read in feedbackItem.ts, the status write-back in
// sendStatus.ts) are small enough that it carries no transport copy (CLAUDE.md, #35) — just this
// one POST helper.

const MONDAY_API_URL = 'https://api.monday.com/v2';
// Explicit pin (#39): Monday serves a deprecated version as the maintenance one, so a stale pin
// drifts silently. Keep this in step with MONDAY_API_VERSION in the other Workers'
// src/monday/graphql.ts by hand.
const MONDAY_API_VERSION = '2026-07';
// Bound every call so a hung Monday API can't hold the webhook (or a waitUntil) indefinitely.
const MONDAY_TIMEOUT_MS = 10_000;

/** POSTs one GraphQL request and returns `data`; throws on any HTTP, GraphQL, or empty-data failure. */
export async function mondayRequest<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(MONDAY_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': MONDAY_API_VERSION },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json()) as { data?: T; errors?: { message: string }[]; error_message?: string };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  // Monday's rate-limit/auth-failure shape: HTTP 200, no data, no errors array.
  if (!json.data) throw new Error(json.error_message ?? 'response contained no data');
  return json.data;
}
