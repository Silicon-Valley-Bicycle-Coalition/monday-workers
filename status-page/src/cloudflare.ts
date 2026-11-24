// Cloudflare's own platform status (cloudflarestatus.com, a Statuspage), narrowed to the products
// SVBC's Workers run on. A configured component the feed doesn't list (renamed, removed) shows as
// unknown rather than disappearing.

import type { StatusConfig } from './config';
import { fetchJson } from './feeds/fetchJson';
import { componentLevel, parseStatuspage } from './feeds/statuspage';
import type { Incident, Level } from './types';
import { summaryUrl } from './vendors';

export interface CloudflareSection {
  statusPageUrl: string;
  components: { name: string; level: Level }[];
  incidents: Incident[];
}

export async function cloudflareSection(
  cfg: StatusConfig['cloudflare'],
  opts: { timeoutMs: number; cacheSeconds: number },
): Promise<CloudflareSection> {
  const res = await fetchJson(summaryUrl(cfg.statusPageUrl), opts);
  const summary = res.ok ? parseStatuspage(res.json) : null;
  if (!summary) {
    return { statusPageUrl: cfg.statusPageUrl, components: cfg.components.map((name) => ({ name, level: 'unknown' })), incidents: [] };
  }
  const statusOf = new Map(summary.components.map((c) => [c.name, c.status]));
  const ours = new Set(cfg.components);
  const touchesOurs = (names: string[]) => names.some((n) => ours.has(n));
  return {
    statusPageUrl: cfg.statusPageUrl,
    components: cfg.components.map((name) => {
      const status = statusOf.get(name);
      return { name, level: status === undefined ? 'unknown' : componentLevel(status) };
    }),
    incidents: [
      ...summary.incidents.filter((i) => touchesOurs(i.componentNames)),
      ...summary.maintenances.filter((m) => m.status === 'in_progress' && touchesOurs(m.componentNames)),
    ].map((i) => ({ name: i.name, url: i.shortlink })),
  };
}
