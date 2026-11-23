import type { VendorSpec } from './config';
import { fetchJson } from './feeds/fetchJson';
import { parseGoogle } from './feeds/google';
import { parseSlack } from './feeds/slack';
import { indicatorLevel, parseStatuspage } from './feeds/statuspage';
import type { Incident, Level } from './types';

export interface VendorRow {
  name: string;
  usedFor: string;
  statusPageUrl: string | null;
  level: Level;
  incidents: Incident[];
}

export const summaryUrl = (base: string) => `${base.replace(/\/+$/, '')}/api/v2/summary.json`;

type Read = { level: Level; incidents: Incident[] };

async function read(spec: VendorSpec, opts: { timeoutMs: number; cacheSeconds: number }): Promise<Read> {
  const feed = spec.feed;
  if (feed.kind === 'none') return { level: 'link-only', incidents: [] };
  const res = await fetchJson(feed.kind === 'statuspage' ? summaryUrl(feed.url) : feed.url, opts);
  if (!res.ok) return { level: 'unknown', incidents: [] };
  if (feed.kind === 'slack') return parseSlack(res.json) ?? { level: 'unknown', incidents: [] };
  if (feed.kind === 'google') return parseGoogle(res.json, feed.products) ?? { level: 'unknown', incidents: [] };
  const s = parseStatuspage(res.json);
  if (!s) return { level: 'unknown', incidents: [] };
  // Vendors aren't component-filtered: any unresolved incident is worth showing.
  return { level: indicatorLevel(s.indicator), incidents: s.incidents.map((i) => ({ name: i.name, url: i.shortlink })) };
}

export async function vendorRow(spec: VendorSpec, opts: { timeoutMs: number; cacheSeconds: number }): Promise<VendorRow> {
  const { level, incidents } = await read(spec, opts);
  return { name: spec.name, usedFor: spec.usedFor, statusPageUrl: spec.statusPageUrl, level, incidents };
}
