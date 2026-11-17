import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { cronSubjects, writeSwitchSubjects, queueSubjects } from './checks';
import { CloudflareApiError, type CloudflareApi } from './cloudflare';
import type { WatchdogConfig } from './config';
import type { SubjectState } from './state';

const NOW = new Date('2026-11-17T19:40:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const cfg: WatchdogConfig = {
  accountId: 'acct',
  watched: {
    'funraise-sync': {
      script: 'svbc-funraise-sync',
      expectedWrites: 'on',
      crons: [{ cron: '0 * * * *', maxGapHours: 3 }, { cron: '0 9 * * *', maxGapHours: 48 }],
    },
    'monday-auth': { script: 'svbc-monday-auth', expectedWrites: null, crons: [] },
    'contact-roles': { script: 'svbc-contact-roles', expectedWrites: 'off', crons: [] },
  },
  notLive: {},
  queues: [{ name: 'funraise-sync-writes', maxBacklogAgeHours: 6 }],
};

const armedLongAgo = (): Map<string, SubjectState> =>
  new Map(
    ['cron:funraise-sync:0 * * * *', 'cron:funraise-sync:0 9 * * *'].map((s) => [
      s,
      { armedAt: hoursAgo(1000).toISOString(), bad: false, lastAlertAt: null, detail: null },
    ]),
  );

function api(over: Partial<CloudflareApi>): CloudflareApi {
  return {
    lastScheduledRun: async () => null,
    queueBacklog: async () => ({ count: 0, oldestAgeHours: null }),
    ...over,
  };
}

describe('cronSubjects', () => {
  it('no run within maxGapHours is unhealthy with "no run since"', async () => {
    const lastRuns: Record<string, Date> = { '0 * * * *': hoursAgo(5), '0 9 * * *': hoursAgo(10) };
    const results = await cronSubjects(cfg, api({ lastScheduledRun: async (_s, cron) => lastRuns[cron]! }), armedLongAgo(), NOW);
    const hourly = results.find((r) => r.subject === 'cron:funraise-sync:0 * * * *')!;
    const daily = results.find((r) => r.subject === 'cron:funraise-sync:0 9 * * *')!;
    expect(hourly.health).toEqual({ ok: false, detail: `no run since ${hoursAgo(5).toISOString()}` });
    expect(daily.health).toEqual({ ok: true });
  });

  it('asks for runs since now − maxGapHours only (keeps GraphQL ranges short)', async () => {
    const sinces: Record<string, string> = {};
    await cronSubjects(cfg, api({ lastScheduledRun: async (_s, cron, since) => { sinces[cron] = since.toISOString(); return null; } }), armedLongAgo(), NOW);
    expect(sinces['0 * * * *']).toBe(hoursAgo(3).toISOString());
    expect(sinces['0 9 * * *']).toBe(hoursAgo(48).toISOString());
  });

  it('a subject armed less than maxGapHours ago is ok even with no runs', async () => {
    const states = new Map<string, SubjectState>([
      ['cron:funraise-sync:0 * * * *', { armedAt: hoursAgo(1).toISOString(), bad: false, lastAlertAt: null, detail: null }],
    ]);
    const results = await cronSubjects(cfg, api({}), states, NOW);
    expect(results.find((r) => r.subject === 'cron:funraise-sync:0 * * * *')!.health).toEqual({ ok: true });
  });

  it('a subject never seen before is ok (it arms now)', async () => {
    const results = await cronSubjects(cfg, api({}), new Map(), NOW);
    expect(results.every((r) => r.health !== 'check-failed' && r.health.ok)).toBe(true);
  });

  it('an API error is check-failed for that subject only', async () => {
    const results = await cronSubjects(
      cfg,
      api({ lastScheduledRun: async (_s, cron) => { if (cron === '0 9 * * *') throw new CloudflareApiError('boom'); return hoursAgo(0.5); } }),
      armedLongAgo(),
      NOW,
    );
    expect(results.find((r) => r.subject === 'cron:funraise-sync:0 9 * * *')!.health).toBe('check-failed');
    expect(results.find((r) => r.subject === 'cron:funraise-sync:0 * * * *')!.health).toEqual({ ok: true });
  });
});

describe('writeSwitchSubjects', () => {
  it('missing key reads as off and is unhealthy when expected on', async () => {
    const flags = env.FLAGS;
    await flags.delete('funraise-sync:writes');
    const results = await writeSwitchSubjects(cfg, flags);
    expect(results.find((r) => r.subject === 'writes:funraise-sync')!.health).toEqual({ ok: false, detail: 'writes are off, expected on' });
  });

  it('value equal to expectedWrites is ok; Workers with expectedWrites null are skipped', async () => {
    const flags = env.FLAGS;
    await flags.put('funraise-sync:writes', 'on');
    const results = await writeSwitchSubjects(cfg, flags);
    expect(results.map((r) => r.subject).sort()).toEqual(['writes:contact-roles', 'writes:funraise-sync']);
    expect(results.every((r) => r.health !== 'check-failed' && r.health.ok)).toBe(true);
  });

  it('a KV get that throws gives check-failed, not unhealthy', async () => {
    const broken = { get: async () => { throw new Error('KV unavailable'); } } as unknown as KVNamespace;
    const results = await writeSwitchSubjects(cfg, broken);
    expect(results.every((r) => r.health === 'check-failed')).toBe(true);
  });
});

describe('queueSubjects', () => {
  it('backlog older than maxBacklogAgeHours is unhealthy with count', async () => {
    const results = await queueSubjects(cfg, api({ queueBacklog: async () => ({ count: 12, oldestAgeHours: 7.5 }) }));
    expect(results[0]).toEqual({ subject: 'queue:funraise-sync-writes', health: { ok: false, detail: '12 messages waiting, oldest 7.5 h' } });
  });

  it('an empty or younger backlog is ok', async () => {
    expect((await queueSubjects(cfg, api({})))[0]!.health).toEqual({ ok: true });
    expect((await queueSubjects(cfg, api({ queueBacklog: async () => ({ count: 3, oldestAgeHours: 1 }) })))[0]!.health).toEqual({ ok: true });
  });

  it('an API error is check-failed', async () => {
    const results = await queueSubjects(cfg, api({ queueBacklog: async () => { throw new CloudflareApiError('down'); } }));
    expect(results[0]!.health).toBe('check-failed');
    expect(results[0]!.error).toContain('down');
  });
});
