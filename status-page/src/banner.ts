// The "N things need attention" list. What counts (design doc): any SVBC sync that isn't running,
// paused or backed up; a watchdog that has stopped reporting; Cloudflare components and vendors at
// outage. Degraded, maintenance and "Couldn't check" stay on their rows: Cloudflare marks
// components degraded often enough that counting them would keep the banner permanently amber.

import type { CloudflareSection } from './cloudflare';
import type { SyncSection, SyncState } from './syncs';
import { sinceTime } from './time';
import type { VendorRow } from './vendors';

const SYNC_WORDS: Partial<Record<SyncState, string>> = {
  'not-running': 'not running',
  paused: 'paused',
  'switch-changed': 'write switch changed',
  'backed-up': 'backed up',
};

export function attentionItems(
  m: { syncs: SyncSection; cloudflare: CloudflareSection; vendors: VendorRow[] },
  timezone: string,
  now: Date = new Date(),
): string[] {
  const items: string[] = [];
  if (m.syncs.stale) {
    items.push(m.syncs.runAt ? `The sync watchdog hasn't reported since ${sinceTime(m.syncs.runAt, timezone, now)}` : "The sync watchdog hasn't reported yet");
  } else {
    for (const r of m.syncs.rows) {
      const word = SYNC_WORDS[r.state];
      if (word) items.push(`${r.label}: ${word}`);
    }
  }
  for (const c of m.cloudflare.components) if (c.level === 'outage') items.push(`Cloudflare ${c.name}: outage`);
  for (const v of m.vendors) if (v.level === 'outage') items.push(`${v.name}: outage`);
  return items;
}

// Rows that couldn't be checked. They stay out of the attention count, but the banner must not
// say "All systems normal" over them (the design's anti-goal: never green when unchecked). A
// stale watchdog already has its own attention line, so its rows aren't counted again.
export function uncheckedCount(m: { syncs: SyncSection; cloudflare: CloudflareSection; vendors: VendorRow[] }): number {
  const syncs = m.syncs.stale ? 0 : m.syncs.rows.filter((r) => r.state === 'unknown').length;
  return syncs + m.cloudflare.components.filter((c) => c.level === 'unknown').length + m.vendors.filter((v) => v.level === 'unknown').length;
}
