import { afterEach, describe, expect, it, vi } from 'vitest';
import monday from './feeds/fixtures/monday-summary.json';
import { vendorRow } from './vendors';

const opts = { timeoutMs: 3000, cacheSeconds: 60 };
let urls: string[];
function stub(respond: () => Response) {
  urls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    return respond();
  });
}
afterEach(() => vi.unstubAllGlobals());
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('vendorRow', () => {
  it('link-only vendor never fetches', async () => {
    stub(() => Response.json({}));
    const row = await vendorRow({ name: 'Benevity', usedFor: 'Workplace giving', statusPageUrl: null, feed: { kind: 'none' } }, opts);
    expect(row).toEqual({ name: 'Benevity', usedFor: 'Workplace giving', statusPageUrl: null, level: 'link-only', incidents: [] });
    expect(urls).toEqual([]);
  });

  it('statuspage vendor reads summary.json', async () => {
    stub(() => Response.json(monday));
    const row = await vendorRow({ name: 'Monday.com', usedFor: 'CRM', statusPageUrl: 'https://status.monday.com', feed: { kind: 'statuspage', url: 'https://status.monday.com' } }, opts);
    expect(urls).toEqual(['https://status.monday.com/api/v2/summary.json']);
    expect(row.level).toBe('operational');
  });

  it('a statuspage vendor whose feed 500s is unknown', async () => {
    stub(() => new Response('', { status: 500 }));
    const row = await vendorRow({ name: 'Box', usedFor: 'Files', statusPageUrl: 'https://status.box.com', feed: { kind: 'statuspage', url: 'https://status.box.com/' } }, opts);
    expect(row.level).toBe('unknown');
    expect(urls).toEqual(['https://status.box.com/api/v2/summary.json']);
  });

  it('a feed that parses as garbage is unknown', async () => {
    stub(() => Response.json({ hello: 'world' }));
    const row = await vendorRow({ name: 'Slack', usedFor: 'Chat', statusPageUrl: 'https://slack-status.com', feed: { kind: 'slack', url: 'https://slack-status.com/api/v2.0.0/current' } }, opts);
    expect(row.level).toBe('unknown');
  });

  it('lists unresolved statuspage incidents', async () => {
    stub(() => Response.json({ ...monday, status: { indicator: 'major' }, incidents: [{ name: 'Boards not loading', shortlink: 'https://stspg.io/x', components: [] }] }));
    const row = await vendorRow({ name: 'Monday.com', usedFor: 'CRM', statusPageUrl: 'https://status.monday.com', feed: { kind: 'statuspage', url: 'https://status.monday.com' } }, opts);
    expect(row.level).toBe('outage');
    expect(row.incidents).toEqual([{ name: 'Boards not loading', url: 'https://stspg.io/x' }]);
  });
});
