import { afterEach, describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { BACKUP_CRON, WATCHDOG_CRON } from './index';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import type { Env } from './env';

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
      worker.scheduled({ scheduledTime: Date.now(), cron: BACKUP_CRON } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as Env),
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
    await worker.scheduled({ scheduledTime: Date.now(), cron: WATCHDOG_CRON } as ScheduledController, {
      ...env,
      SLACK_WEBHOOK_URL: '',
    } as unknown as Env);
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
    await worker.scheduled({ scheduledTime: Date.now(), cron: WATCHDOG_CRON } as ScheduledController, {
      ...env,
      ENVIRONMENT: 'sandbox',
      SLACK_WEBHOOK_URL: '',
    } as unknown as Env);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
