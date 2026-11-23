import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './feeds/fixtures/cloudflare-summary.json';
import { cloudflareSection } from './cloudflare';

const opts = { timeoutMs: 3000, cacheSeconds: 60 };
const cfg = (components: string[]) => ({ statusPageUrl: 'https://www.cloudflarestatus.com', components });
const serve = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', async (url: string) => {
    expect(url).toBe('https://www.cloudflarestatus.com/api/v2/summary.json');
    return Response.json(body, { status });
  });
afterEach(() => vi.unstubAllGlobals());
vi.spyOn(console, 'error').mockImplementation(() => {});

const incident = (name: string, components: string[]) => ({ name, status: 'investigating', shortlink: `https://stspg.io/${name}`, components: components.map((c) => ({ name: c })) });
const maintenance = (name: string, status: string, components: string[]) => ({ ...incident(name, components), status });

describe('cloudflareSection', () => {
  it('filters to configured components, in config order', async () => {
    serve(fixture);
    const s = await cloudflareSection(cfg(['Workers', 'Queues', 'D1']), opts);
    expect(s.components).toEqual([
      { name: 'Workers', level: 'degraded' },
      { name: 'Queues', level: 'degraded' },
      { name: 'D1', level: 'operational' },
    ]);
    expect(s.statusPageUrl).toBe('https://www.cloudflarestatus.com');
  });

  it('configured component missing from feed is unknown', async () => {
    serve(fixture);
    const s = await cloudflareSection(cfg(['Workers KV Legacy']), opts);
    expect(s.components).toEqual([{ name: 'Workers KV Legacy', level: 'unknown' }]);
  });

  it('only incidents touching configured components', async () => {
    serve({ ...fixture, incidents: [incident('net', ['Network']), incident('workers', ['Workers', 'API'])] });
    const s = await cloudflareSection(cfg(['Workers']), opts);
    expect(s.incidents).toEqual([{ name: 'workers', url: 'https://stspg.io/workers' }]);
  });

  it('in-progress maintenance on SJC is listed; scheduled is not', async () => {
    const sjc = 'San Jose, United States - (SJC)';
    serve({ ...fixture, incidents: [], scheduled_maintenances: [maintenance('now', 'in_progress', [sjc]), maintenance('later', 'scheduled', [sjc])] });
    const s = await cloudflareSection(cfg([sjc]), opts);
    expect(s.incidents).toEqual([{ name: 'now', url: 'https://stspg.io/now' }]);
  });

  it('feed failure makes every component unknown', async () => {
    serve({}, 502);
    const s = await cloudflareSection(cfg(['Workers', 'D1']), opts);
    expect(s.components.map((c) => c.level)).toEqual(['unknown', 'unknown']);
    expect(s.incidents).toEqual([]);
  });
});
