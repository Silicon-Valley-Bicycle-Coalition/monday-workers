import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import { createApp } from './routes';
import { D1AppTokenStore } from './tokenStore';
import { parsePrefixes, parseWebhookOp } from './webhooks';
import { TEST_ENC_KEY } from '../test/enc-key';

afterEach(() => vi.restoreAllMocks());

const TOKEN = 'WEBHOOK-SECRET-TOKEN-VALUE';
const KEY = 'the-start-key-is-at-least-32-chars';
const PREFIX = 'https://rollups.example.workers.dev/webhooks/monday/';
const HOOK_URL = `${PREFIX}donations?secret=URL-SECRET-VALUE`;
const testEnv = {
  ...(env as unknown as Env),
  START_KEY: KEY,
  WEBHOOKS_ENABLED: 'true',
  WEBHOOK_URL_PREFIXES: `${PREFIX}, https://promote.example.workers.dev/webhooks/monday/`,
} as Env;

interface Seen {
  auth: string | null;
  query: string;
  variables: Record<string, unknown>;
}

function fakeMonday(reply: (query: string) => Response = (query) =>
  Response.json({
    data: query.includes('create_webhook')
      ? { create_webhook: { id: '900', board_id: '5', event: 'create_item', config: null } }
      : query.includes('delete_webhook')
        ? { delete_webhook: { id: '900', board_id: '5' } }
        : { webhooks: [{ id: '900', event: 'create_item', board_id: '5', config: null }] },
  })) {
  const seen: Seen[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    seen.push({ auth: new Headers(init?.headers).get('Authorization'), query: body.query, variables: body.variables });
    return reply(body.query);
  }) as typeof fetch;
  return { fetchFn, seen };
}

function appWith(fetchFn: typeof fetch, over: Partial<Env> = {}, broker: { token(app: any): Promise<string> } | null = { token: async () => TOKEN }) {
  return createApp({ store: new D1AppTokenStore(env.DB, TEST_ENC_KEY), env: { ...testEnv, ...over }, fetchFn, now: () => new Date(), broker: broker ?? undefined });
}

const post = (app: ReturnType<typeof createApp>, fields: Record<string, string>, appKey = 'sync') =>
  app.request(`https://broker.test/oauth/webhooks/${appKey}`, { method: 'POST', body: new URLSearchParams(fields) });

describe('POST /oauth/webhooks/:app', () => {
  it('is 404 before the key check unless WEBHOOKS_ENABLED is exactly "true"', async () => {
    for (const flag of [undefined, 'false', 'TRUE', '1', '']) {
      const { fetchFn, seen } = fakeMonday();
      let brokerCalls = 0;
      const app = appWith(fetchFn, { WEBHOOKS_ENABLED: flag }, { token: async () => (brokerCalls++, TOKEN) });
      expect((await post(app, { key: KEY, op: 'list', board: '5' })).status).toBe(404);
      expect(brokerCalls + seen.length).toBe(0);
    }
  });

  it('requires the key, and a known app', async () => {
    const { fetchFn, seen } = fakeMonday();
    const app = appWith(fetchFn);
    expect((await post(app, { op: 'list', board: '5' })).status).toBe(403);
    expect((await post(app, { key: 'wrong', op: 'list', board: '5' })).status).toBe(403);
    expect((await post(app, { key: KEY, op: 'list', board: '5' }, 'nope')).status).toBe(404);
    // GET is not a route: nothing is read from a URL.
    expect((await app.request(`https://broker.test/oauth/webhooks/sync?key=${KEY}&op=list&board=5`)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('lists a board with the app token, sent bare', async () => {
    const { fetchFn, seen } = fakeMonday();
    const res = await post(appWith(fetchFn), { key: KEY, op: 'list', board: '5' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webhooks: [{ id: '900', event: 'create_item', board_id: '5', config: null }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(TOKEN);
    expect(seen[0]!.variables).toEqual({ board: '5' });
  });

  it('creates a webhook with variables, never interpolated, and does not log the url', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchFn, seen } = fakeMonday();
    const res = await post(appWith(fetchFn), { key: KEY, op: 'create', board: '5', url: HOOK_URL, event: 'change_specific_column_value', config: '{"columnId":"color_x"}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ create_webhook: { id: '900' } });
    expect(seen[0]!.variables).toEqual({ board: '5', url: HOOK_URL, event: 'change_specific_column_value', config: '{"columnId":"color_x"}' });
    expect(seen[0]!.query).not.toContain('URL-SECRET-VALUE');
    expect(log.mock.calls.flat().join(' ')).not.toContain('URL-SECRET-VALUE');
    expect(log.mock.calls.flat().join(' ')).toContain('create on board 5');
  });

  it('sends a null config when none is given', async () => {
    const { fetchFn, seen } = fakeMonday();
    await post(appWith(fetchFn), { key: KEY, op: 'create', board: '5', url: HOOK_URL, event: 'create_item' });
    expect(seen[0]!.variables.config).toBeNull();
  });

  it('deletes by webhook id', async () => {
    const { fetchFn, seen } = fakeMonday();
    const res = await post(appWith(fetchFn), { key: KEY, op: 'delete', id: '900' });
    expect(res.status).toBe(200);
    expect(seen[0]!.query).toContain('delete_webhook');
    expect(seen[0]!.variables).toEqual({ id: '900' });
  });

  it('refuses a url outside WEBHOOK_URL_PREFIXES before any token or Monday call', async () => {
    const bad = [
      'https://evil.example/webhooks/monday/donations',
      'http://rollups.example.workers.dev/webhooks/monday/donations',
      'https://rollups.example.workers.dev.evil.example/webhooks/monday/donations',
      'https://user@rollups.example.workers.dev/webhooks/monday/donations',
      'https://rollups.example.workers.dev/other/path',
      'not a url',
    ];
    for (const url of bad) {
      const { fetchFn, seen } = fakeMonday();
      let brokerCalls = 0;
      const app = appWith(fetchFn, {}, { token: async () => (brokerCalls++, TOKEN) });
      const res = await post(app, { key: KEY, op: 'create', board: '5', url, event: 'create_item' });
      expect(res.status, url).toBe(400);
      expect(brokerCalls + seen.length).toBe(0);
    }
  });

  it('refuses every create when WEBHOOK_URL_PREFIXES is unset', async () => {
    const { fetchFn, seen } = fakeMonday();
    const res = await post(appWith(fetchFn, { WEBHOOK_URL_PREFIXES: undefined }), { key: KEY, op: 'create', board: '5', url: HOOK_URL, event: 'create_item' });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('is 409 when the broker cannot hand out a token', async () => {
    const { fetchFn } = fakeMonday();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith(fetchFn, {}, { token: async () => { throw new Error('sync app needs consent'); } });
    const res = await post(app, { key: KEY, op: 'list', board: '5' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('needs consent');
  });

  it('is 502 on a Monday error, with the token and the url scrubbed from body and log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchFn } = fakeMonday(() =>
      Response.json({ errors: [{ message: `bad token ${TOKEN} for ${HOOK_URL}` }] }));
    const res = await post(appWith(fetchFn), { key: KEY, op: 'create', board: '5', url: HOOK_URL, event: 'create_item' });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('[redacted]');
    for (const out of [text, error.mock.calls.flat().join(' ')]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('URL-SECRET-VALUE');
    }
  });

  it('is 502 when fetch throws, without the token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = (async () => { throw new Error(`timed out with ${TOKEN}`); }) as typeof fetch;
    const res = await post(appWith(fetchFn), { key: KEY, op: 'list', board: '5' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe('parseWebhookOp', () => {
  const prefixes = [PREFIX];
  it('validates each op', () => {
    expect(parseWebhookOp({ op: 'list', board: 'x' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'delete', id: '' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'rename' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'create', board: '5', url: HOOK_URL, event: 'Create Item' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'create', board: '5', url: HOOK_URL, event: 'create_item', config: '[1]' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'create', board: '5', url: HOOK_URL, event: 'create_item', config: '{' }, prefixes)).toHaveProperty('error');
    expect(parseWebhookOp({ op: 'create', board: '5', url: HOOK_URL, event: 'create_item' }, prefixes)).toEqual({
      op: 'create', board: '5', url: HOOK_URL, event: 'create_item',
    });
  });
});

describe('parsePrefixes', () => {
  it('keeps only https prefixes that name a path', () => {
    expect(parsePrefixes(undefined)).toEqual([]);
    expect(parsePrefixes(' https://a.dev/x/ , http://b.dev/x/, https://c.dev, https://d.dev/ ')).toEqual(['https://a.dev/x/', 'https://d.dev/']);
  });
});
