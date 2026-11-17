import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runWatchdog, type RunDeps } from './run';
import { CloudflareApiError, type CloudflareApi } from './cloudflare';
import type { WatchdogConfig } from './config';
import type { SubjectState } from './state';

const TUESDAY = new Date('2026-11-17T19:40:00Z');
const MONDAY_1640 = new Date('2026-11-16T16:40:00Z');
const LONG_AGO = '2026-10-01T00:00:00.000Z';
const WEBHOOK = 'https://hooks.slack.test/services/x';

const cfg: WatchdogConfig = {
  accountId: 'acct',
  watched: { 'funraise-sync': { script: 'svbc-funraise-sync', expectedWrites: 'on', crons: [{ cron: '0 * * * *', maxGapHours: 3 }] } },
  notLive: {},
  queues: [{ name: 'funraise-sync-writes', maxBacklogAgeHours: 6 }],
};
const SUBJECTS = ['cron:funraise-sync:0 * * * *', 'writes:funraise-sync', 'queue:funraise-sync-writes'];

const healthyApi = (now: Date): CloudflareApi => ({
  lastScheduledRun: async () => new Date(now.getTime() - 30 * 60_000),
  queueBacklog: async () => ({ count: 0, oldestAgeHours: null }),
});

let slack: { status: number; posts: string[] };
let errors: string[];

async function armAll(over: Partial<SubjectState> = {}) {
  for (const s of SUBJECTS) {
    await env.STATE.put(`subject:${s}`, JSON.stringify({ armedAt: LONG_AGO, bad: false, lastAlertAt: null, detail: null, ...over }));
  }
}
const stateOf = async (s: string) => JSON.parse((await env.STATE.get(`subject:${s}`))!) as SubjectState;

function deps(over: Partial<RunDeps> = {}): RunDeps {
  const now = over.now ?? TUESDAY;
  return { cfg, api: healthyApi(now), flags: env.FLAGS, state: env.STATE, slackWebhookUrl: WEBHOOK, now, environment: 'production', ...over };
}

beforeEach(async () => {
  slack = { status: 200, posts: [] };
  errors = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe(WEBHOOK);
    slack.posts.push((JSON.parse(String(init.body)) as { text: string }).text);
    return new Response('ok', { status: slack.status });
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const s of SUBJECTS) await env.STATE.delete(`subject:${s}`);
  await env.FLAGS.put('funraise-sync:writes', 'on');
});
afterEach(() => vi.restoreAllMocks());

describe('runWatchdog', () => {
  it('posts one message per state change and stores state under "subject:<subject>"', async () => {
    await armAll();
    await env.FLAGS.put('funraise-sync:writes', 'hold');
    await runWatchdog(deps());
    expect(slack.posts).toEqual(['sync-watchdog: writes:funraise-sync: writes are hold, expected on']);
    const s = await stateOf('writes:funraise-sync');
    expect(s.bad).toBe(true);
    expect(s.lastAlertAt).toBe(TUESDAY.toISOString());
    await runWatchdog(deps({ now: new Date(TUESDAY.getTime() + 3_600_000) }));
    expect(slack.posts).toHaveLength(1);
  });

  it('a failed Slack POST leaves lastAlertAt unset so the next run posts again', async () => {
    await armAll();
    await env.FLAGS.put('funraise-sync:writes', 'off');
    slack.status = 500;
    await runWatchdog(deps());
    expect((await stateOf('writes:funraise-sync')).lastAlertAt).toBeNull();
    slack.status = 200;
    await runWatchdog(deps({ now: new Date(TUESDAY.getTime() + 3_600_000) }));
    expect(slack.posts).toHaveLength(2);
    expect((await stateOf('writes:funraise-sync')).lastAlertAt).not.toBeNull();
  });

  it('check-failed subjects keep their previous state and log one console.error naming them', async () => {
    await armAll({ bad: true, lastAlertAt: LONG_AGO, detail: '3 messages waiting, oldest 9.0 h' });
    const api: CloudflareApi = { ...healthyApi(TUESDAY), queueBacklog: async () => { throw new CloudflareApiError('metrics down'); } };
    await runWatchdog(deps({ api }));
    expect((await stateOf('queue:funraise-sync-writes')).bad).toBe(true);
    expect(slack.posts.some((p) => p.includes('queue:funraise-sync-writes'))).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('queue:funraise-sync-writes');
    expect(errors[0]).toContain('metrics down');
  });

  it('heartbeat posts on Monday at 16:xx UTC only', async () => {
    await armAll();
    await runWatchdog(deps());
    expect(slack.posts).toEqual([]);
    await runWatchdog(deps({ now: MONDAY_1640, api: healthyApi(MONDAY_1640) }));
    expect(slack.posts).toEqual(['sync-watchdog: running, 3 of 3 subjects healthy']);
  });

  it('sandbox environment never posts to Slack', async () => {
    await armAll();
    await env.FLAGS.put('funraise-sync:writes', 'off');
    await runWatchdog(deps({ environment: 'sandbox', now: MONDAY_1640, api: healthyApi(MONDAY_1640) }));
    expect(slack.posts).toEqual([]);
  });

  it('messages start with "sync-watchdog:" and contain no @', async () => {
    await armAll();
    await env.FLAGS.put('funraise-sync:writes', 'off');
    await runWatchdog(deps({ now: MONDAY_1640, api: healthyApi(MONDAY_1640) }));
    expect(slack.posts.length).toBeGreaterThan(0);
    for (const p of slack.posts) {
      expect(p.startsWith('sync-watchdog:')).toBe(true);
      expect(p).not.toContain('@');
    }
  });
});
