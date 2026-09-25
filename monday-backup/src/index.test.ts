import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { BACKUP_CRON, WATCHDOG_CRON } from './index';
import wranglerText from '../wrangler.jsonc?raw';
import { parseJsonc } from '../test/jsonc';
import type { Env } from './types';

type Json = Record<string, unknown>;

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
  });
});
