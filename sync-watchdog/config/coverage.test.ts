import { describe, it, expect } from 'vitest';
import production from './svbc.json';
import sandbox from './sandbox.json';
import ownWrangler from '../wrangler.jsonc?raw';
import flagsScript from '../../scripts/check-worker-flags.mjs?raw';
import { parseJsonc } from '../test/jsonc';

// Keeps config/svbc.json in step with the repo: every production cron in any Worker's
// wrangler.jsonc is either watched (with a gap long enough for its schedule) or listed in
// notLive with a reason. Taking a Worker live fails here until it moves to `watched`.
// Design: docs/superpowers/specs/2026-11-17-sync-failure-alerting-design.md.

type Json = Record<string, unknown>;
interface CronWatch { cron: string; maxGapHours: number }
interface Watched { script: string; expectedWrites: string | null; crons: CronWatch[] }
const cfg = production as unknown as {
  watched: Record<string, Watched>;
  notLive: Record<string, string>;
  queues: { name: string; maxBacklogAgeHours: number }[];
  domains: { zone: string; customDomains: Record<string, string>; routes: Record<string, string | null>; pending: Record<string, { script: string }> };
};

const raw = import.meta.glob('../../*/wrangler.jsonc', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const workers = Object.fromEntries(
  Object.entries(raw)
    .map(([path, text]) => [path.split('/').at(-2)!, parseJsonc(text) as Json] as const)
    // Vite resolves this Worker's own file as `../wrangler.jsonc`, so it shows up as `..`.
    .filter(([dir]) => dir !== 'sync-watchdog' && dir !== '..'),
);
// Every wrangler file, the member-portal writer's included, for the Custom Domains check.
const allRaw = import.meta.glob('../../*/wrangler*.jsonc', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
type Route = { pattern: string; custom_domain?: boolean };
// hostname -> script for every custom_domain route, per environment. An env block without its own
// `routes` inherits the top level's, as Wrangler does.
const declaredDomains = new Map<string, string>();
const declaredRoutes: string[] = [];
for (const text of Object.values(allRaw)) {
  const w = parseJsonc(text) as Json & { routes?: Route[]; env?: Record<string, Json & { routes?: Route[] }> };
  const add = (routes: Route[] | undefined, script: string) => {
    for (const r of routes ?? []) {
      if (r.custom_domain) declaredDomains.set(r.pattern, script);
      else declaredRoutes.push(r.pattern);
    }
  };
  add(w.routes, String(w.name));
  for (const [env, e] of Object.entries(w.env ?? {})) add('routes' in e ? e.routes : w.routes, String(e.name ?? `${w.name}-${env}`));
}

const crons = (w: Json): string[] => ((w.triggers as Json | undefined)?.crons as string[] | undefined) ?? [];
const producers = (w: Json): string[] =>
  (((w.queues as Json | undefined)?.producers as { queue: string }[] | undefined) ?? []).map((p) => p.queue);

const inScope = JSON.parse(
  (/export const IN_SCOPE = (\[[^\]]*\])/.exec(flagsScript)?.[1] ?? '[]').replace(/'/g, '"').replace(/,\s*\]/, ']'),
) as string[];

// Hours between runs for the expression shapes in use: `*/N * * * *`, `M * * * *`,
// `M H * * *`, `M H * * D`.
function intervalHours(cron: string): number {
  const [min, hour, , , dow] = cron.split(' ');
  if (min!.startsWith('*/')) return Number(min!.slice(2)) / 60;
  if (hour === '*') return 1;
  if (dow !== '*') return 168;
  return 24;
}
const floorHours = (cron: string): number => {
  const i = intervalHours(cron);
  return i < 24 ? 3 : i < 168 ? 30 : 192;
};

describe('watchdog coverage', () => {
  it('finds the repo Workers', () => {
    expect(Object.keys(workers)).toContain('funraise-sync');
    expect(inScope).toContain('funraise-sync');
  });

  it('selfScript is this Worker in each environment', () => {
    const own = parseJsonc(ownWrangler) as Json & { env: { sandbox: Json } };
    expect(production.selfScript).toBe(own.name);
    expect(sandbox.selfScript).toBe(own.env.sandbox.name);
  });

  it('every Worker with production crons is watched or notLive, never both', () => {
    for (const [dir, w] of Object.entries(workers)) {
      const watched = dir in cfg.watched;
      const notLive = dir in cfg.notLive;
      expect(watched && notLive, `${dir} is in both watched and notLive`).toBe(false);
      if (crons(w).length > 0) expect(watched || notLive, `${dir} has production crons but is in neither list`).toBe(true);
    }
  });

  it('every watched cron matches a production cron of that Worker', () => {
    for (const [dir, watch] of Object.entries(cfg.watched)) {
      const w = workers[dir];
      expect(w, `${dir} has no wrangler.jsonc`).toBeDefined();
      expect(watch.script).toBe(w!.name);
      expect(watch.crons.map((c) => c.cron).sort(), dir).toEqual([...crons(w!)].sort());
    }
  });

  it('every maxGapHours is at least the cron interval and its floor', () => {
    for (const [dir, watch] of Object.entries(cfg.watched)) {
      for (const c of watch.crons) {
        expect(c.maxGapHours, `${dir} ${c.cron}`).toBeGreaterThanOrEqual(Math.max(intervalHours(c.cron), floorHours(c.cron)));
      }
    }
  });

  it('expectedWrites is null exactly when the Worker has no write switch', () => {
    for (const [dir, watch] of Object.entries(cfg.watched)) {
      expect(watch.expectedWrites === null, dir).toBe(!inScope.includes(dir));
    }
  });

  it('every queue is a production producer queue of a watched Worker', () => {
    const known = Object.keys(cfg.watched).flatMap((dir) => producers(workers[dir] ?? {}));
    for (const q of cfg.queues) expect(known, q.name).toContain(q.name);
  });

  it('domains lists every Custom Domain in any wrangler file, on its script, and nothing else', () => {
    const expected = new Map([
      ...Object.entries(cfg.domains.customDomains),
      ...Object.entries(cfg.domains.pending).map(([h, p]) => [h, p.script] as const),
    ]);
    expect(declaredDomains.size).toBeGreaterThan(5);
    expect(Object.fromEntries([...expected].sort())).toEqual(Object.fromEntries([...declaredDomains].sort()));
    for (const host of declaredDomains.keys()) expect(host.endsWith(`.${cfg.domains.zone}`), host).toBe(true);
  });

  it('domains.routes matches the plain routes in wrangler files (none today)', () => {
    expect(Object.keys(cfg.domains.routes).sort()).toEqual([...declaredRoutes].sort());
  });
});
