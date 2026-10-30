import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from './env';
import { createApp } from './routes';
import { D1AppTokenStore } from './tokenStore';

const TOKEN = 'PROBE-SECRET-TOKEN-VALUE';
const testEnv = { ...(env as unknown as Env), START_KEY: 'the-start-key', PROBE_ENABLED: 'true' } as Env;

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

function appWith(fetchFn: typeof fetch, broker: { token(app: any): Promise<string> } | null = { token: async () => TOKEN }, over: Partial<Env> = {}) {
  return createApp({ store: new D1AppTokenStore(env.DB), env: { ...testEnv, ...over }, fetchFn, now: () => new Date(), broker: broker ?? undefined });
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

  it('measures complexity first and alone', async () => {
    const order: string[] = [];
    let complexityDone = false;
    const base = fakeMonday().fetchFn;
    const fetchFn = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const q = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (q.includes('complexity')) {
        order.push('complexity');
        await new Promise((r) => setTimeout(r, 20));
        complexityDone = true;
      } else {
        expect(complexityDone).toBe(true);
        order.push('other');
      }
      return base(u, init);
    }) as typeof fetch;
    const res = await appWith(fetchFn).request(url());
    expect(res.status).toBe(200);
    expect(order[0]).toBe('complexity');
    expect(order.filter((o) => o === 'complexity')).toHaveLength(1);
    expect(order.length).toBeGreaterThan(1);
  });

  it('records a timeout as that check failing, without the token', async () => {
    const base = fakeMonday().fetchFn;
    const fetchFn = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const q = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (q.includes('platform_api')) throw new DOMException(`timed out ${TOKEN}`, 'TimeoutError');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return base(u, init);
    }) as typeof fetch;
    const res = await appWith(fetchFn).request(url());
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.platformApi.ok).toBe(false);
    expect(body.bareHeader).toEqual({ ok: true });
  });

  it('is 404 before the key check unless PROBE_ENABLED is exactly "true"', async () => {
    for (const flag of ['false', '', 'TRUE', undefined]) {
      let brokerCalls = 0;
      let fetchCalls = 0;
      const fetchFn = (async () => {
        fetchCalls++;
        return Response.json({});
      }) as typeof fetch;
      const broker = { token: async () => (brokerCalls++, TOKEN) };
      const app = appWith(fetchFn, broker, { PROBE_ENABLED: flag });
      expect((await app.request(url())).status).toBe(404);
      expect((await app.request('https://broker.test/oauth/probe/readonly?workspace=7')).status).toBe(404);
      expect(brokerCalls + fetchCalls).toBe(0);
    }
  });

  it('is 409 when the broker throws, and only mentions consent when it says so', async () => {
    const transient = appWith(fakeMonday().fetchFn, { token: async () => { throw new Error('D1 hiccup'); } });
    const r1 = await transient.request(url());
    expect(r1.status).toBe(409);
    expect(await r1.text()).not.toMatch(/consent/i);
    const consent = appWith(fakeMonday().fetchFn, {
      token: async () => { throw new Error('monday-auth: the readonly app needs consent; re-run'); },
    });
    const r2 = await consent.request(url());
    expect(r2.status).toBe(409);
    expect(await r2.text()).toMatch(/consent/i);
  });

  it('is 500 when no broker is configured', async () => {
    expect((await appWith(fakeMonday().fetchFn, null).request(url())).status).toBe(500);
  });

  it('never leaks the token from an HTTP error body that echoes it bare and as Bearer', async () => {
    const fetchFn = (async () =>
      Response.json({ error_message: `bad auth ${TOKEN} / Bearer ${TOKEN}` }, { status: 401 })) as typeof fetch;
    const res = await appWith(fetchFn).request(url());
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).bareHeader.ok).toBe(false);
  });
});
