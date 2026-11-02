import { describe, it, expect, vi } from 'vitest';

vi.mock('./access', () => ({
  requireAccess: () => async (c: any, next: () => Promise<void>) => {
    const email = c.req.header('x-test-staff');
    if (!email) return c.text('Forbidden', 403);
    c.set('staffEmail', email);
    await next();
  },
}));

import { buildApp } from './routes';
import { fakeDeps, fakeEnv } from './testing';
import { PREVIEW_STATE_SRC, renderPage } from './page';

const STAFF = { 'x-test-staff': 'staff@example.org' };

function get(path: string, event: { name: string; address: string } | null = null, headers: Record<string, string> = STAFF) {
  const app = buildApp(() => fakeDeps({ event }));
  return app.request(path, { headers }, fakeEnv().env);
}

describe('GET /', () => {
  it('requires Access', async () => {
    expect((await get('/', null, {})).status).toBe(403);
  });

  it('serves the page with pinned Leaflet and turf and the board picker', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('leaflet@1.9.4/dist/leaflet.css');
    expect(html).toContain('leaflet@1.9.4/dist/leaflet.js');
    expect(html).toContain('@turf/turf@7.2.0/turf.min.js');
    expect(html).toContain('id="board"');
    expect(html).toContain('OpenStreetMap contributors');
  });

  it('loads every third-party asset with SRI and crossorigin=anonymous', async () => {
    const html = await (await get('/')).text();
    const tags = html.match(/<(?:script|link)\b[^>]*(?:unpkg\.com|cdn\.jsdelivr\.net)[^>]*>/g) ?? [];
    expect(tags).toHaveLength(3);
    for (const tag of tags) {
      expect(tag).toMatch(/ integrity="sha384-[A-Za-z0-9+/]{64}"/);
      expect(tag).toContain(' crossorigin="anonymous"');
    }
    expect(html).toContain('integrity="sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H"');
  });

  it('embeds the event for ?event=<id>', async () => {
    const html = await (await get('/?event=123', { name: 'Bike Rodeo', address: '1 Main St, San Jose' })).text();
    expect(html).toContain('"eventItemId":"123"');
    expect(html).toContain('"eventName":"Bike Rodeo"');
    expect(html).toContain('"address":"1 Main St, San Jose"');
    expect(html).toContain('"miles":2');
  });

  it('renders an event-not-found notice for an unknown event', async () => {
    const res = await get('/?event=999', null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/event not found/i);
    expect(html).not.toContain('"eventItemId"');
  });
});

describe('GET / when the Monday lookup fails', () => {
  it('renders the event-not-found notice', async () => {
    const deps = fakeDeps();
    deps.monday.getEventAddress = async () => { throw new Error('monday down'); };
    const res = await buildApp(() => deps).request('/?event=5', { headers: STAFF }, fakeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/event not found/i);
  });
});

// The page embeds this source verbatim, so evaluating it tests the shipped logic.
const makeState = (): any => new Function(`${PREVIEW_STATE_SRC}; return createPreviewState();`)();

describe('preview state', () => {
  it('confirm posts the exact body that was previewed, not later edits', () => {
    const s = makeState();
    const body = { query: 'A', miles: 0.5 };
    const t = s.begin(body);
    body.query = 'edited after click';
    expect(s.settle(t, { ok: 1 })).toBe(true);
    expect(s.snapshot()).toEqual({ query: 'A', miles: 0.5 });
  });

  it('discards a response that arrives after the inputs changed (clear)', () => {
    const s = makeState();
    const t = s.begin({ query: 'A', miles: 1 });
    s.clear();
    expect(s.isLatest(t)).toBe(false);
    expect(s.settle(t, { ok: 1 })).toBe(false);
    expect(s.preview()).toBeNull();
    expect(s.snapshot()).toBeNull();
  });

  it('discards an older response when a newer preview was started', () => {
    const s = makeState();
    const t1 = s.begin({ query: 'A', miles: 1 });
    const t2 = s.begin({ query: 'B', miles: 1 });
    expect(s.settle(t1, { ok: 'old' })).toBe(false);
    expect(s.settle(t2, { ok: 'new' })).toBe(true);
    expect(s.snapshot()).toEqual({ query: 'B', miles: 1 });
  });

  it('is wired into the page: confirm uses the snapshot', () => {
    const html = renderPage();
    expect(html).toContain('state.snapshot()');
    expect(html).toContain('state.isLatest(token)');
  });
});

describe('renderPage', () => {
  it('cannot be broken out of by data in the embedded JSON', () => {
    const html = renderPage({ event: { eventItemId: '1', eventName: '</script><script>alert(1)</script>', address: 'a', miles: 2 } });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });
});
