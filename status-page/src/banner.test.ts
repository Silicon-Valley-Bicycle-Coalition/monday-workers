import { describe, expect, it } from 'vitest';
import { attentionItems } from './banner';
import type { CloudflareSection } from './cloudflare';
import type { SyncRow, SyncSection } from './syncs';
import type { VendorRow } from './vendors';

const TZ = 'America/Los_Angeles';
const row = (label: string, state: SyncRow['state']): SyncRow => ({ label, description: '', state, details: [], lastRunAt: null });
const syncs = (...rows: SyncRow[]): SyncSection => ({ runAt: '2026-11-20T18:40:00.000Z', stale: false, rows });
const cf = (...components: CloudflareSection['components']): CloudflareSection => ({ statusPageUrl: 'https://www.cloudflarestatus.com', components, incidents: [] });
const vendor = (name: string, level: VendorRow['level']): VendorRow => ({ name, usedFor: '', statusPageUrl: null, level, incidents: [] });

describe('attentionItems', () => {
  it('all healthy is empty', () =>
    expect(attentionItems({ syncs: syncs(row('A', 'running')), cloudflare: cf({ name: 'Workers', level: 'operational' }), vendors: [vendor('Slack', 'operational')] }, TZ)).toEqual([]));

  it('degraded, maintenance and unknown stay off the banner', () =>
    expect(
      attentionItems({
        syncs: syncs(row('A', 'unknown')),
        cloudflare: cf({ name: 'Queues', level: 'degraded' }, { name: 'SJC', level: 'maintenance' }),
        vendors: [vendor('Box', 'unknown'), vendor('Benevity', 'link-only'), vendor('Zoom', 'degraded')],
      }, TZ),
    ).toEqual([]));

  it('lists sync problems by staff label', () =>
    expect(
      attentionItems({ syncs: syncs(row('Mailchimp ↔ Monday', 'paused'), row('Funraise donations → Monday', 'not-running'), row('Member portal', 'backed-up')), cloudflare: cf(), vendors: [] }, TZ),
    ).toEqual(['Mailchimp ↔ Monday: paused', 'Funraise donations → Monday: not running', 'Member portal: backed up']));

  it('a stale snapshot is one watchdog line and no per-sync lines', () => {
    const stale: SyncSection = { runAt: '2026-11-20T14:40:00.000Z', stale: true, rows: [row('A', 'unknown')] };
    expect(attentionItems({ syncs: stale, cloudflare: cf(), vendors: [] }, TZ)).toEqual(["The sync watchdog hasn't reported since 6:40 AM"]);
    expect(attentionItems({ syncs: { ...stale, runAt: null }, cloudflare: cf(), vendors: [] }, TZ)).toEqual(["The sync watchdog hasn't reported yet"]);
  });

  it('Cloudflare and vendor outages', () =>
    expect(attentionItems({ syncs: syncs(), cloudflare: cf({ name: 'D1', level: 'outage' }), vendors: [vendor('Slack', 'outage')] }, TZ)).toEqual([
      'Cloudflare D1: outage',
      'Slack: outage',
    ]));
});
