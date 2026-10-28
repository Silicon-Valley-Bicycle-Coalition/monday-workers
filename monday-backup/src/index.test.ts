import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { BACKUP_CRON, WATCHDOG_CRON } from './index';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import type { Env } from './env';

// The backup itself is covered in backup.test.ts. Module mocks don't reach the workers pool, so
// "runBackup was (not) called" is read off its first side effect: the snapshot_runs row it records
// before touching Drive or Monday. These tests' fake env has no Google key, so a live run throws.
const runCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot_runs').first<{ n: number }>())!.n;

afterEach(async () => {
  await env.DB.prepare('DELETE FROM snapshot_runs').run();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flags = (value: string | null | Error) =>
  ({ get: vi.fn(async () => { if (value instanceof Error) throw value; return value; }) }) as unknown as KVNamespace;
const cron = (c: string) => ({ scheduledTime: Date.now(), cron: c }) as ScheduledController;
const withFlags = (value: string | null | Error, extra: Record<string, unknown> = {}) =>
  ({ ...env, SLACK_WEBHOOK_URL: 'https://hooks.example/webhook', FLAGS: flags(value), ...extra }) as unknown as Env;

type Json = Record<string, unknown>;

// A platform_api response well under the 50% threshold, so the usage check runs but stays quiet.
function stubMondayUsage() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        platform_api: {
          daily_limit: { total: 10_000 },
          daily_analytics: { last_updated: null, by_day: [{ day: new Date().toISOString().slice(0, 10), usage: 10 }] },
        },
      },
    }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// The fetch calls that went to Slack rather than Monday's API (the same stub answers both).
const slackCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => !String(url).startsWith('https://api.monday.com'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker entry point', () => {
  it('exposes fetch and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value instead of running a backup with a guessed config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: BACKUP_CRON } as ScheduledController, withFlags('on', { ENVIRONMENT: 'staging' })),
    ).rejects.toThrow('ENVIRONMENT');
  });

  it('wrangler.jsonc schedules both the nightly backup and the hourly watchdog, in both environments', () => {
    const wrangler = parseJsonc(wranglerText) as Json;
    const sandbox = (wrangler.env as Json).sandbox as Json;
    for (const block of [wrangler, sandbox]) {
      expect((block.triggers as Json).crons).toEqual([BACKUP_CRON, WATCHDOG_CRON]);
    }
  });

  it('routes the watchdog cron to the watchdog, not a backup run', async () => {
    const fetchMock = stubMondayUsage();
    await worker.scheduled(cron(WATCHDOG_CRON), withFlags('on', { SLACK_WEBHOOK_URL: '' }));
    const state = await env.DB.prepare('SELECT watchdog_armed_at FROM run_alert_state WHERE id = 1').first<{
      watchdog_armed_at: string | null;
    }>();
    expect(state?.watchdog_armed_at).not.toBeNull();
    const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot_runs').first<{ n: number }>();
    expect(runs?.n).toBe(0);
    // Production config turns on the account-wide usage check: one platform_api query, no alert.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).query).toContain('platform_api');
  });

  it('skips the usage check in the sandbox, which shares the production Monday account', async () => {
    const fetchMock = stubMondayUsage();
    await worker.scheduled(cron(WATCHDOG_CRON), withFlags('on', { ENVIRONMENT: 'sandbox', SLACK_WEBHOOK_URL: '' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('write switch', () => {
    it('reads <worker>:writes once per cron run', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const e = withFlags('on');
      await worker.scheduled(cron(BACKUP_CRON), e).catch(() => {});
      const keys = (e.FLAGS.get as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([k]) => k as string);
      expect(keys.filter((k) => k === 'monday-backup:writes')).toHaveLength(1);
      expect(e.FLAGS.get).toHaveBeenCalledWith('monday-backup:writes', { cacheTtl: 30 });
    });

    it('on: runs the backup', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await worker.scheduled(cron(BACKUP_CRON), withFlags('on')).catch(() => {});
      expect(await runCount()).toBe(1);
    });

    it.each([
      ['hold', 'hold'],
      ['a KV read error', new Error('kv down')],
    ] as const)('%s: backup cron skips, with a skip line and no D1 run row', async (_l, value) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await worker.scheduled(cron(BACKUP_CRON), withFlags(value));
      expect(logSpy.mock.calls.some(([l]) => String(l).includes('skipped'))).toBe(true);
      expect(await runCount()).toBe(0);
    });

    it.each([
      ['off', 'off'],
      ['a missing key', null],
    ] as const)('%s: backup cron skips and logs a skip line', async (_l, value) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await worker.scheduled(cron(BACKUP_CRON), withFlags(value));
      expect(await runCount()).toBe(0);
      expect(logSpy.mock.calls.some(([l]) => String(l).includes('skipped'))).toBe(true);
    });

    it('watchdog off with a stale snapshot: no Slack fetch, and a skip line', async () => {
      await env.DB.prepare("UPDATE run_alert_state SET watchdog_armed_at = '2020-01-01T00:00:00.000Z', last_stale_alert_at = NULL WHERE id = 1").run();
      const fetchMock = stubMondayUsage();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await worker.scheduled(cron(WATCHDOG_CRON), withFlags('off'));
      // The usage check's Monday read still runs (a read, not a write); nothing reaches Slack.
      expect(slackCalls(fetchMock)).toHaveLength(0);
      expect(logSpy.mock.calls.some(([l]) => String(l).includes('skipped'))).toBe(true);
    });

    it('watchdog on with a stale snapshot: alerts Slack as today', async () => {
      await env.DB.prepare("UPDATE run_alert_state SET watchdog_armed_at = '2020-01-01T00:00:00.000Z', last_stale_alert_at = NULL WHERE id = 1").run();
      const fetchMock = stubMondayUsage();
      await worker.scheduled(cron(WATCHDOG_CRON), withFlags('on'));
      expect(slackCalls(fetchMock)).toHaveLength(1);
    });
  });
});

describe('wrangler.jsonc FLAGS binding', () => {
  it('binds FLAGS in production and sandbox to different namespaces', () => {
    const wrangler = parseJsonc(wranglerText) as Json;
    const idOf = (b: Json) => ((b.kv_namespaces as { binding: string; id: string }[] | undefined) ?? []).find((n) => n.binding === 'FLAGS')?.id;
    const sandbox = (wrangler.env as Json).sandbox as Json;
    expect(idOf(wrangler)).toBeTruthy();
    expect(idOf(sandbox)).toBeTruthy();
    expect(idOf(sandbox)).not.toBe(idOf(wrangler));
  });
});
