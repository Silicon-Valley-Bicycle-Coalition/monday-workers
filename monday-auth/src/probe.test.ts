import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from './env';
import { createApp } from './routes';
import { D1AppTokenStore } from './tokenStore';

const TOKEN = 'PROBE-SECRET-TOKEN-VALUE';
const testEnv = { ...(env as unknown as Env), START_KEY: 'the-start-key' } as Env;

interface Seen {
  auth: string | null;
  query: string;
}

// Fake Monday GraphQL. `failing` names a query fragment whose request gets a GraphQL error.
function fakeMonday(failing?: string) {
  const seen: Seen[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    const auth = new Headers(init?.headers).get('Authorization');
    seen.push({ auth, query });
    if (failing && query.includes(failing)) return Response.json({ errors: [{ message: `${failing} denied` }] });
    if (query.includes('platform_api')) return Response.json({ data: { platform_api: { daily_limit: { base: 5000 } } } });
    if (query.includes('complexity')) {
      return Response.json({ data: { complexity: { before: 100, after: 90, reset_in_x_seconds: 30 }, me: { id: '42' } } });
    }
    if (query.includes('boards(')) {
      return Response.json({ data: { boards: [{ id: '1', workspace_id: '7', board_kind: 'public', permissions: 'everyone', state: 'active' }] } });
    }
    if (query.includes('workspaces')) return Response.json({ data: { me: { id: '42', name: 'Sam' }, workspaces: [{ id: '7', name: 'WS' }] } });
    return Response.json({ data: { me: { id: '42', name: 'Sam' } } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function appWith(fetchFn: typeof fetch) {
  const broker = { token: async () => TOKEN };
  return createApp({ store: new D1AppTokenStore(env.DB), env: testEnv, fetchFn, now: () => new Date(), broker });
}

const url = (extra = '') => `https://broker.test/oauth/probe/readonly?key=the-start-key&workspace=7${extra}`;

describe('GET /oauth/probe/:app', () => {
  it('probe requires the key', async () => {
    const { fetchFn, seen } = fakeMonday();
    const app = appWith(fetchFn);
    expect((await app.request('https://broker.test/oauth/probe/readonly?workspace=7')).status).toBe(403);
    expect((await app.request('https://broker.test/oauth/probe/readonly?key=wrong&workspace=7')).status).toBe(403);
    expect((await app.request('https://broker.test/oauth/probe/nope?key=the-start-key&workspace=7')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('requires a numeric workspace', async () => {
    const app = appWith(fakeMonday().fetchFn);
    expect((await app.request('https://broker.test/oauth/probe/readonly?key=the-start-key')).status).toBe(400);
    expect((await app.request('https://broker.test/oauth/probe/readonly?key=the-start-key&workspace=abc')).status).toBe(400);
  });

  it('reports every check on success and sends the token both ways', async () => {
    const { fetchFn, seen } = fakeMonday();
    const res = await appWith(fetchFn).request(url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.me).toEqual({ id: '42', name: 'Sam' });
    expect(body.scope.total).toBe(1);
    expect(body.scope.inside).toBe(1);
    expect(body.bareHeader).toEqual({ ok: true });
    expect(body.bearerHeader).toEqual({ ok: true });
    expect(body.platformApi).toEqual({ ok: true });
    expect(body.complexity).toEqual({ before: 100, after: 90, resetInSeconds: 30 });
    expect(seen.some((s) => s.auth === TOKEN)).toBe(true);
    expect(seen.some((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('probe reports each check independently when one fails', async () => {
    const { fetchFn } = fakeMonday('platform_api');
    const res = await appWith(fetchFn).request(url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.platformApi.ok).toBe(false);
    expect(body.platformApi.error).toContain('platform_api denied');
    expect(body.bareHeader).toEqual({ ok: true });
    expect(body.me).toEqual({ id: '42', name: 'Sam' });
    expect(body.complexity.before).toBe(100);
  });

  it('probe output never contains the token', async () => {
    for (const failing of [undefined, 'platform_api', 'complexity', 'boards(', 'me {']) {
      const { fetchFn } = fakeMonday(failing);
      const res = await appWith(fetchFn).request(url());
      expect(await res.text()).not.toContain(TOKEN);
    }
    const throwing = (async () => {
      throw new Error(`network down for ${TOKEN}`);
    }) as typeof fetch;
    const res = await appWith(throwing).request(url());
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(res.status).toBe(200);
  });
});
