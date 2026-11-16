import type { FetchFn } from './mondayOAuth';

// Webhook subscriptions made with an app's own token (#110). Monday signs a webhook's deliveries
// with the Signing Secret of the app that created it, and only then; one created with a personal
// token arrives unsigned. The broker never hands a token out, so operators register through this
// narrow surface instead: list, create and delete webhooks, nothing else.

const API_URL = 'https://api.monday.com/v2';
// Same pin as MONDAY_API_VERSION in monday-backup/src/monday/graphql.ts (#39).
const API_VERSION = '2026-07';

export type WebhookOp =
  | { op: 'list'; board: string }
  | { op: 'create'; board: string; url: string; event: string; config?: string }
  | { op: 'delete'; id: string };

export type WebhookResult = { ok: true; data: unknown } | { ok: false; status: 400 | 502; error: string };

const NUMERIC = /^\d+$/;
// Monday's WebhookEventType values are lower snake case; anything else is a typo, not an event.
const EVENT = /^[a-z][a-z_]{2,63}$/;

// Parses the posted fields into one operation, or says what's wrong with them. `allowedPrefixes`
// pins where a new webhook may point: without it a leaked START_KEY could subscribe an outside URL
// to any board the app can read and receive every change on it.
export function parseWebhookOp(fields: Record<string, string>, allowedPrefixes: readonly string[]): WebhookOp | { error: string } {
  const op = fields.op;
  if (op === 'list') {
    if (!NUMERIC.test(fields.board ?? '')) return { error: 'board must be a numeric board id' };
    return { op, board: fields.board! };
  }
  if (op === 'delete') {
    if (!NUMERIC.test(fields.id ?? '')) return { error: 'id must be a numeric webhook id' };
    return { op, id: fields.id! };
  }
  if (op === 'create') {
    if (!NUMERIC.test(fields.board ?? '')) return { error: 'board must be a numeric board id' };
    if (!EVENT.test(fields.event ?? '')) return { error: 'event must be a Monday webhook event type' };
    if (!urlAllowed(fields.url ?? '', allowedPrefixes)) return { error: 'url is not under an allowed WEBHOOK_URL_PREFIXES entry' };
    const config = fields.config ?? '';
    if (config !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(config);
      } catch {
        return { error: 'config must be a JSON object' };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'config must be a JSON object' };
    }
    return { op, board: fields.board!, url: fields.url!, event: fields.event!, ...(config === '' ? {} : { config }) };
  }
  return { error: 'op must be list, create or delete' };
}

// Comma-separated `https://host/path/` prefixes. The URL is compared after parsing, as origin plus
// path, so neither userinfo nor a lookalike host can pass, and the query (the URL secret) is free.
export function parsePrefixes(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('https://') && s.indexOf('/', 'https://'.length) > 0);
}

function urlAllowed(raw: string, prefixes: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const target = url.origin + url.pathname;
  return prefixes.some((p) => target.startsWith(p));
}

const QUERIES: Record<WebhookOp['op'], string> = {
  list: 'query ($board: ID!) { webhooks(board_id: $board) { id event board_id config } }',
  create: `mutation ($board: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
    create_webhook(board_id: $board, url: $url, event: $event, config: $config) { id board_id event config } }`,
  delete: 'mutation ($id: ID!) { delete_webhook(id: $id) { id board_id } }',
};

// One request, no retry: a create that timed out may have committed, and the operator re-lists
// before trying again. The token, and the URL (whose query carries the Worker's secret), are
// scrubbed from any error text; neither is ever returned.
export async function runWebhookOp(op: WebhookOp, token: string, fetchFn: FetchFn): Promise<WebhookResult> {
  const variables =
    op.op === 'list' ? { board: op.board } : op.op === 'delete' ? { id: op.id } : { board: op.board, url: op.url, event: op.event, config: op.config ?? null };
  const secrets = [token, ...(op.op === 'create' ? [op.url, encodeURI(op.url)] : [])];
  const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text).slice(0, 300);
  try {
    const res = await fetchFn(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': API_VERSION },
      body: JSON.stringify({ query: QUERIES[op.op], variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: unknown; errors?: { message?: string }[]; error_message?: string } | null;
    if (!res.ok || body === null || body.errors || !body.data) {
      const detail = body?.errors?.map((e) => e.message).join('; ') ?? body?.error_message;
      return { ok: false, status: 502, error: scrub(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`) };
    }
    return { ok: true, data: body.data };
  } catch (err) {
    return { ok: false, status: 502, error: scrub(err instanceof Error ? err.message : 'error') };
  }
}
