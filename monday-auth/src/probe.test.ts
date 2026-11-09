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
function fakeMonday(failing?: string, boardRead: unknown = { boards: [] }) {
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
    if (query.includes('boards(ids')) return Response.json({ data: boardRead });
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

const PROBE = 'https://broker.test/oauth/probe/readonly';
// START_KEY is posted as a form field (never in the URL).
const probe = (app: ReturnType<typeof createApp>, fields: Record<string, string> = { key: 'the-start-key', workspace: '7' }, url = PROBE) =>
  app.request(url, { method: 'POST', body: new URLSearchParams(fields) });

describe('/oauth/probe/:app', () => {
  it('probe requires the key', async () => {
    const { fetchFn, seen } = fakeMonday();
    const app = appWith(fetchFn);
    expect((await probe(app, { workspace: '7' })).status).toBe(403);
    expect((await probe(app, { key: 'wrong', workspace: '7' })).status).toBe(403);
    expect((await probe(app, { key: 'the-start-key', workspace: '7' }, 'https://broker.test/oauth/probe/nope')).status).toBe(404);
    // A key in the URL is ignored: GET only shows the form.
    const get = await app.request(`${PROBE}?key=the-start-key&workspace=7`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('method="post"');
    expect(seen).toEqual([]);
  });

  it('requires a numeric workspace', async () => {
    const app = appWith(fakeMonday().fetchFn);
    expect((await probe(app, { key: 'the-start-key' })).status).toBe(400);
    expect((await probe(app, { key: 'the-start-key', workspace: 'abc' })).status).toBe(400);
  });

  it('reports every check on success and sends the token both ways', async () => {
    const { fetchFn, seen } = fakeMonday();
    const res = await probe(appWith(fetchFn));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.app).toBe('readonly');
    expect(Object.keys(body)[0]).toBe('app');
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
    const res = await probe(appWith(fetchFn));
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
      const res = await probe(appWith(fetchFn));
      expect(await res.text()).not.toContain(TOKEN);
    }
    const throwing = (async () => {
      throw new Error(`network down for ${TOKEN}`);
    }) as typeof fetch;
    const res = await probe(appWith(throwing));
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
    const res = await probe(appWith(fetchFn));
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
    const res = await probe(appWith(fetchFn));
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
      expect((await probe(app)).status).toBe(404);
      expect((await probe(app, { workspace: '7' })).status).toBe(404);
      expect((await app.request(PROBE)).status).toBe(404);
      expect(brokerCalls + fetchCalls).toBe(0);
    }
  });

  it('is 409 when the broker throws, and only mentions consent when it says so', async () => {
    const transient = appWith(fakeMonday().fetchFn, { token: async () => { throw new Error('D1 hiccup'); } });
    const r1 = await probe(transient);
    expect(r1.status).toBe(409);
    expect(await r1.text()).not.toMatch(/consent/i);
    const consent = appWith(fakeMonday().fetchFn, {
      token: async () => { throw new Error('monday-auth: the readonly app needs consent; re-run'); },
    });
    const r2 = await probe(consent);
    expect(r2.status).toBe(409);
    expect(await r2.text()).toMatch(/consent/i);
  });

  it('is 500 when no broker is configured', async () => {
    expect((await probe(appWith(fakeMonday().fetchFn, null))).status).toBe(500);
  });

  it('never leaks the token from an HTTP error body that echoes it bare and as Bearer', async () => {
    const fetchFn = (async () =>
      Response.json({ error_message: `bad auth ${TOKEN} / Bearer ${TOKEN}` }, { status: 401 })) as typeof fetch;
    const res = await probe(appWith(fetchFn));
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).bareHeader.ok).toBe(false);
  });

  describe('the optional board read', () => {
    const fields = { key: 'the-start-key', workspace: '7', board: '18437342592' };
    const boardQueries = (seen: Seen[]) => seen.filter((s) => s.query.includes('boards(ids'));

    it('reports empty when the token gets nothing back for that id', async () => {
      const { fetchFn, seen } = fakeMonday();
      const res = await probe(appWith(fetchFn), fields);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.board).toEqual({ id: '18437342592', empty: true });
      expect(boardQueries(seen).map((s) => s.query)).toEqual(['{ boards(ids: [18437342592]) { id } }']);
      expect(boardQueries(seen)[0]!.auth).toBe(TOKEN);
    });

    it('reports not empty when the board comes back, and nothing about the board', async () => {
      const { fetchFn } = fakeMonday(undefined, { boards: [{ id: '18437342592', name: 'SECRET-BOARD-NAME' }] });
      const res = await probe(appWith(fetchFn), fields);
      const text = await res.text();
      expect((JSON.parse(text) as Record<string, any>).board).toEqual({ id: '18437342592', empty: false });
      expect(text).not.toContain('SECRET-BOARD-NAME');
    });

    it('does not read an unexpected answer or an error as empty', async () => {
      const odd = await probe(appWith(fakeMonday(undefined, { boards: null }).fetchFn), fields);
      expect(((await odd.json()) as Record<string, any>).board.ok).toBe(false);
      const denied = await probe(appWith(fakeMonday('boards(ids').fetchFn), fields);
      const body = (await denied.json()) as Record<string, any>;
      expect(body.board.ok).toBe(false);
      expect(body.board.error).toContain('denied');
      expect(body.bareHeader).toEqual({ ok: true });
    });

    it('scrubs the token from a failed read', async () => {
      const fetchFn = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        const q = (JSON.parse(String(init?.body)) as { query: string }).query;
        if (q.includes('boards(ids')) return Response.json({ errors: [{ message: `no ${TOKEN}` }] });
        return fakeMonday().fetchFn(_u, init);
      }) as typeof fetch;
      const text = await (await probe(appWith(fetchFn), fields)).text();
      expect(text).not.toContain(TOKEN);
      expect((JSON.parse(text) as Record<string, any>).board.ok).toBe(false);
    });

    it('sends no board read and adds no board key when the field is absent or blank', async () => {
      for (const extra of [{}, { board: '' }] as Record<string, string>[]) {
        const { fetchFn, seen } = fakeMonday();
        const res = await probe(appWith(fetchFn), { key: 'the-start-key', workspace: '7', ...extra });
        expect(res.status).toBe(200);
        expect('board' in ((await res.json()) as Record<string, any>)).toBe(false);
        expect(boardQueries(seen)).toEqual([]);
      }
    });

    it('refuses a non-numeric id before any Monday call or token', async () => {
      for (const board of ['abc', '1) { id name } #', '1,2', '-1', ' 12']) {
        let brokerCalls = 0;
        const { fetchFn, seen } = fakeMonday();
        const app = appWith(fetchFn, { token: async () => (brokerCalls++, TOKEN) });
        expect((await probe(app, { key: 'the-start-key', workspace: '7', board })).status, board).toBe(400);
        expect(seen).toEqual([]);
        expect(brokerCalls).toBe(0);
      }
    });

    it('keeps the key gate and the PROBE_ENABLED gate', async () => {
      const { fetchFn, seen } = fakeMonday();
      expect((await probe(appWith(fetchFn), { workspace: '7', board: '1' })).status).toBe(403);
      expect((await probe(appWith(fetchFn, undefined, { PROBE_ENABLED: 'false' }), fields)).status).toBe(404);
      expect(seen).toEqual([]);
    });

    it('offers the field on the form', async () => {
      const get = await appWith(fakeMonday().fetchFn).request(PROBE);
      expect(await get.text()).toContain('name="board"');
    });
  });
});
