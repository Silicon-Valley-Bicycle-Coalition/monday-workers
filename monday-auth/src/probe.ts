import { listBoards, summarizeScope } from '../../scripts/lib/token-scope.mjs';
import type { AppKey } from './apps';
import type { FetchFn } from './mondayOAuth';

const API_URL = 'https://api.monday.com/v2';
// Same pin as MONDAY_API_VERSION in monday-backup/src/monday/graphql.ts (#39).
const API_VERSION = '2026-07';

export type Check = { ok: true } | { ok: false; error: string };

export interface ProbeReport {
  app: AppKey;
  me: { id: string; name: string } | { ok: false; error: string };
  scope: ReturnType<typeof summarizeScope> | { ok: false; error: string };
  bareHeader: Check;
  bearerHeader: Check;
  platformApi: Check;
  complexity: { before: number; after: number; resetInSeconds: number } | { ok: false; error: string };
}

// Direct fetch, not MondayGraphQL: sending the token bare and as a Bearer is the point.
async function gql<T>(fetchFn: FetchFn, authorization: string, query: string): Promise<T> {
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization, 'API-Version': API_VERSION },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[]; error_message?: string } | null;
  if (!res.ok || body === null || body.errors || !body.data) {
    const detail = body?.errors?.map((e) => e.message).join('; ') ?? body?.error_message;
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }
  return body.data;
}

// Runs each check on its own, so one failing never hides the others. Errors are the Monday
// message or HTTP status with any occurrence of the token scrubbed; the token is never returned.
export async function runProbe(app: AppKey, token: string, workspace: string, fetchFn: FetchFn): Promise<ProbeReport> {
  const scrub = (err: unknown): { ok: false; error: string } => {
    const message = err instanceof Error ? err.message : 'error';
    return { ok: false, error: message.split(token).join('[token]').slice(0, 300) };
  };
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
    try {
      return await fn();
    } catch (err) {
      return scrub(err);
    }
  };
  const header = (authorization: string): Promise<Check> =>
    attempt(async () => {
      await gql(fetchFn, authorization, '{ me { id } }');
      return { ok: true as const };
    });

  // Measured alone and first, so `before` is the budget as the probe found it and
  // `before - after` is this one query's cost.
  const complexity = await attempt(async () => {
    const data = await gql<{ complexity: { before: number; after: number; reset_in_x_seconds: number } }>(
      fetchFn,
      token,
      '{ complexity { before after reset_in_x_seconds } me { id } }'
    );
    return {
      before: data.complexity.before,
      after: data.complexity.after,
      resetInSeconds: data.complexity.reset_in_x_seconds,
    };
  });

  const [me, scope, bareHeader, bearerHeader, platformApi] = await Promise.all([
    attempt(async () => (await gql<{ me: { id: string; name: string } }>(fetchFn, token, '{ me { id name } }')).me),
    attempt(async () => summarizeScope(await listBoards((q) => gql(fetchFn, token, q)), [workspace])),
    header(token),
    header(`Bearer ${token}`),
    attempt(async () => {
      await gql(fetchFn, token, '{ platform_api { daily_limit { base } } }');
      return { ok: true as const };
    }),
  ]);
  return { app, me, scope, bareHeader, bearerHeader, platformApi, complexity };
}
