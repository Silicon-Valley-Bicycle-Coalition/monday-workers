import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from './index';

describe('worker entry point', () => {
  it('exposes fetch and scheduled handlers', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('refuses an unknown ENVIRONMENT value instead of running a backup with a guessed config', async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: '0 9 * * *' } as ScheduledController, { ...env, ENVIRONMENT: 'staging' } as unknown as import('./types').Env)
    ).rejects.toThrow('ENVIRONMENT');
  });
});
