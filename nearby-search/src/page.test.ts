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
import { renderPage } from './page';

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

describe('renderPage', () => {
  it('cannot be broken out of by data in the embedded JSON', () => {
    const html = renderPage({ event: { eventItemId: '1', eventName: '</script><script>alert(1)</script>', address: 'a', miles: 2 } });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });
});
