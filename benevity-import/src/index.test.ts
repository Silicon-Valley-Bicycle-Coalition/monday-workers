import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from './index';
import { applyMigrations } from '../test/apply-migrations';

describe('worker entry point', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('exports fetch, queue, and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.queue).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value instead of guessing a config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env)
    ).rejects.toThrow('ENVIRONMENT');
  });

  it('runs the scheduled purge under the sandbox config (regression guard for the request-time config switch)', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '15 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'sandbox' } as unknown as import('./types').Env)
    ).resolves.toBeUndefined();
  });
});
