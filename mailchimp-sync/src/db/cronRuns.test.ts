import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { CRON_RUN_RETENTION_MS, claimCronEvent } from './cronRuns';

const HOUR = 3_600_000;
const T = Date.parse('2026-11-23T14:05:57.341Z');

describe('claimCronEvent', () => {
  it('claims an event once: a second delivery of the same cron and scheduled time is refused', async () => {
    expect(await claimCronEvent(env.DB, '5 * * * *', T, T + 1000)).toBe(true);
    expect(await claimCronEvent(env.DB, '5 * * * *', T, T + 15.5 * 60_000)).toBe(false);
  });

  it('treats the next scheduled time, or another cron at the same time, as a new event', async () => {
    expect(await claimCronEvent(env.DB, '5 * * * *', T + HOUR, T + HOUR)).toBe(true);
    expect(await claimCronEvent(env.DB, '5 * * * *', T + 2 * HOUR, T + 2 * HOUR)).toBe(true);
    expect(await claimCronEvent(env.DB, '20 * * * *', T + 2 * HOUR, T + 2 * HOUR)).toBe(true);
  });

  it('prunes claims older than the retention window as it claims', async () => {
    const old = T - CRON_RUN_RETENTION_MS - HOUR;
    await claimCronEvent(env.DB, '0 15 * * *', old, old);
    await claimCronEvent(env.DB, '0 15 * * *', T, T);
    const rows = await env.DB.prepare(`SELECT scheduled_time FROM cron_runs WHERE cron = '0 15 * * *'`).all<{ scheduled_time: number }>();
    expect(rows.results.map((r) => r.scheduled_time)).toEqual([T]);
  });
});
