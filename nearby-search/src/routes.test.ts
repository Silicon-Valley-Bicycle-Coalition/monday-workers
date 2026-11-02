import { describe, it, expect, vi } from 'vitest';

// Access itself is covered in access.test.ts; here it is replaced by a header check so the tests
// prove every /api route is mounted behind it.
vi.mock('./access', () => ({
  requireAccess: () => async (c: any, next: () => Promise<void>) => {
    const email = c.req.header('x-test-staff');
    if (!email) return c.text('Forbidden', 403);
    c.set('staffEmail', email);
    await next();
  },
}));

import { buildApp } from './routes';
import { OsmError } from './locate/osm';
import { fakeDeps, fakeEnv } from './testing';

const STAFF = { 'x-test-staff': 'staff@example.org', 'content-type': 'application/json' };
const valid = { query: '1 Main St, San Jose', miles: 2, boardId: 900, label: 'Main St ride' };

function setup(mode: 'on' | 'hold' | 'off' | 'error' = 'on', deps = fakeDeps()) {
  const e = fakeEnv(mode);
  const app = buildApp(() => deps);
  const post = (path: string, body: unknown, headers: Record<string, string> = STAFF) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, e.env);
  return { ...e, deps, app, post };
}

describe('auth and limits', () => {
  it.each([['POST', '/api/preview'], ['POST', '/api/confirm'], ['GET', '/api/boards']])('%s %s without Access is 403', async (method, path) => {
    const { app, env, queue } = (() => { const s = setup(); return { app: s.app, env: s.env, queue: s.queue }; })();
    const res = await app.request(path, { method, body: method === 'POST' ? JSON.stringify(valid) : undefined }, env);
    expect(res.status).toBe(403);
    expect(queue.sent).toEqual([]);
  });

  it('leaves /health open', async () => {
    const { app, env } = setup();
    expect((await app.request('/health', {}, env)).status).toBe(200);
  });

  it('answers 429 when the rate limiter refuses, before Access', async () => {
    const { app, env } = setup();
    (env as any).REQUEST_RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await app.request('/api/boards', { headers: STAFF }, env)).status).toBe(429);
  });
});

describe('POST /api/preview', () => {
  it('returns matches and counts for a point', async () => {
    const { post, queue } = setup();
    const res = await post('/api/preview', { query: '1 Main St, San Jose', miles: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.counts.person).toBe(2);
    expect(queue.sent).toEqual([]);
  });

  it('never writes, whatever the mode', async () => {
    const { post, queue, db } = setup('on');
    await post('/api/preview', { query: '1 Main St, San Jose', miles: 2 });
    expect(queue.sent).toEqual([]);
    expect(db.searches).toEqual([]);
  });

  it('returns 422 with the message for not-found', async () => {
    const { post } = setup('on', fakeDeps({ hits: [] }));
    const res = await post('/api/preview', { query: '1 Nowhere St', miles: 2 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).message).toEqual(expect.any(String));
  });

  it('returns 422 for an event with no address', async () => {
    const { post } = setup('on', fakeDeps({ event: null }));
    const res = await post('/api/preview', { eventItemId: '5', miles: 0.5 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ message: 'Event not found or has no address.' });
  });

  it('returns 400 for an empty query and for malformed JSON', async () => {
    const { post, app, env } = setup();
    expect((await post('/api/preview', { query: '  ', miles: 2 })).status).toBe(400);
    expect((await app.request('/api/preview', { method: 'POST', headers: STAFF, body: '{' }, env)).status).toBe(400);
  });

  it('returns 502 when OpenStreetMap fails', async () => {
    const deps = fakeDeps();
    deps.osm.nominatim = async () => { throw new OsmError('down', 503); };
    const { post } = setup('on', deps);
    const res = await post('/api/preview', { query: '1 Main St, San Jose', miles: 2 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: 'OpenStreetMap is unavailable; try again shortly.' });
  });
});

describe('GET /api/boards', () => {
  it('lists results boards', async () => {
    const { app, env } = setup();
    const res = await app.request('/api/boards', { headers: STAFF }, env);
    expect(await res.json()).toEqual([{ id: '900', name: 'Results' }]);
  });
});

describe('POST /api/confirm validation', () => {
  it.each([
    ['miles 0', { ...valid, miles: 0 }],
    ['miles 11', { ...valid, miles: 11 }],
    ['label with comma', { ...valid, label: 'A, B' }],
    ['label of 61 chars', { ...valid, label: 'x'.repeat(61) }],
    ['blank label', { ...valid, label: '   ' }],
    ['unknown board', { ...valid, boardId: 12345 }],
    ['missing board', { query: valid.query, miles: 2, label: 'ok' }],
  ])('400 and nothing queued for %s', async (_name, body) => {
    const { post, queue, db } = setup();
    const res = await post('/api/confirm', body);
    expect(res.status).toBe(400);
    expect(queue.sent).toEqual([]);
    expect(db.searches).toEqual([]);
  });

  it('accepts a 60-char label and trims it', async () => {
    const { post, queue } = setup();
    const res = await post('/api/confirm', { ...valid, label: `  ${'x'.repeat(60)}  ` });
    expect(res.status).toBe(200);
    expect(queue.sent[0]!.label).toBe('x'.repeat(60));
  });
});

describe('POST /api/confirm', () => {
  it.each([['on', 'on'], ['hold', 'hold'], ['off', 'off'], ['error', 'unknown']] as const)('reports writeMode for %s', async (mode, expected) => {
    const { post } = setup(mode);
    expect(((await (await post('/api/confirm', valid)).json()) as any).writeMode).toBe(expected);
  });

  it('queues each match and records the search', async () => {
    const { post, queue, db } = setup();
    const res = await post('/api/confirm', valid);
    expect(await res.json()).toEqual({ queued: 3, alreadyOnBoard: 0, historical: 1, writeMode: 'on' });
    expect(queue.sent.map((m) => m.contactId).sort()).toEqual(['h1', 'p1', 'p2']);
    expect(queue.sent[0]).toMatchObject({ boardId: 900, label: 'Main St ride', stamp: {} });
    expect(db.searches).toHaveLength(1);
    expect(db.searches[0]).toEqual(expect.arrayContaining(['900', 'Main St ride', valid.query, 2, 3, 3, 'staff@example.org']));
  });

  it('queues nothing the second time once the consumer has written the rows', async () => {
    const { post, queue, db } = setup();
    await post('/api/confirm', valid);
    for (const m of queue.sent) db.resultRows.push({ board_id: String(m.boardId), contact_id: m.contactId });
    queue.sent.length = 0;
    const res = await post('/api/confirm', valid);
    expect(await res.json()).toEqual({ queued: 0, alreadyOnBoard: 3, historical: 0, writeMode: 'on' });
    expect(queue.sent).toEqual([]);
    expect(db.searches).toHaveLength(2);
  });

  it('skips a contact already linked on the board', async () => {
    const { post, queue, deps } = setup();
    deps.monday.linked = new Set(['p1']);
    const res = await post('/api/confirm', valid);
    expect(await res.json()).toEqual({ queued: 2, alreadyOnBoard: 1, historical: 1, writeMode: 'on' });
    expect(queue.sent.map((m) => m.contactId)).not.toContain('p1');
  });

  it('skips the linked check when the board has no result columns yet', async () => {
    const { post, deps } = setup();
    deps.monday.columns = null;
    deps.monday.linked = new Set(['p1']);
    expect(((await (await post('/api/confirm', valid)).json()) as any).queued).toBe(3);
  });

  it('counts only queued historical matches', async () => {
    const { post, deps } = setup();
    deps.monday.linked = new Set(['h1']);
    expect(((await (await post('/api/confirm', valid)).json()) as any).historical).toBe(0);
  });

  it('stamps messages dropped under off', async () => {
    const { post, queue } = setup('off');
    await post('/api/confirm', valid);
    expect(queue.sent.every((m) => m.stamp.writeStamp === 'dropped')).toBe(true);
  });

  it.each(['hold', 'error'] as const)('still queues, unstamped, under %s', async (mode) => {
    const { post, queue } = setup(mode);
    await post('/api/confirm', valid);
    expect(queue.sent).toHaveLength(3);
    expect(queue.sent.every((m) => m.stamp.writeStamp === undefined)).toBe(true);
  });

  it('sends in chunks of 100', async () => {
    const { post, queue, deps } = setup();
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, name: 'N', lat: 37.3382, lng: -121.8863, zip: null, kind: 'person' as const }));
    deps.monday.listContacts = async (src: { kind: string }) => (src.kind === 'person' ? many : []);
    const res = await post('/api/confirm', valid);
    expect(((await res.json()) as any).queued).toBe(250);
    expect(queue.batches).toEqual([100, 100, 50]);
  });

  it('answers 422 for not-found and records nothing', async () => {
    const { post, queue, db } = setup('on', fakeDeps({ hits: [] }));
    expect((await post('/api/confirm', valid)).status).toBe(422);
    expect(queue.sent).toEqual([]);
    expect(db.searches).toEqual([]);
  });
});
