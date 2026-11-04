import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { D1SnapshotRunStore } from './runs';

describe('D1SnapshotRunStore', () => {
  it('recordRunFinish marks the run success and resets consecutive_failures', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    const runId = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    // Simulate a prior failure streak that a successful run should clear.
    await store.recordRunFailure(runId, '2026-08-24T09:00:00.000Z', 'boom');

    const secondRunId = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    await store.recordRunFinish(secondRunId, '2026-08-25T09:05:00.000Z', {
      status: 'success',
      boardCount: 10,
      docCount: 3,
      errorCount: 0,
      lastError: null,
    });

    const row = await env.DB.prepare('SELECT * FROM snapshot_runs WHERE id = ?1').bind(secondRunId).first();
    expect(row).toMatchObject({ status: 'success', board_count: 10, doc_count: 3, error_count: 0 });

    const alertState = await env.DB.prepare('SELECT consecutive_failures FROM run_alert_state WHERE id = 1').first<{
      consecutive_failures: number;
    }>();
    expect(alertState?.consecutive_failures).toBe(0);
  });

  it('recordRunFailure increments consecutive_failures and returns the new count', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    const runId1 = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    const first = await store.recordRunFailure(runId1, '2026-08-25T09:01:00.000Z', 'drive auth failed');
    expect(first).toBe(1);

    const runId2 = await store.recordRunStart('2026-08-26T09:00:00.000Z');
    const second = await store.recordRunFailure(runId2, '2026-08-26T09:01:00.000Z', 'drive auth failed again');
    expect(second).toBe(2);

    const row = await env.DB.prepare('SELECT * FROM snapshot_runs WHERE id = ?1').bind(runId2).first();
    expect(row).toMatchObject({ status: 'failure', last_error: 'drive auth failed again' });
  });

  it('recordRunFinish with a partial status preserves the error detail', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    const runId = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    await store.recordRunFinish(runId, '2026-08-25T09:05:00.000Z', {
      status: 'partial',
      boardCount: 9,
      docCount: 2,
      errorCount: 1,
      lastError: 'board 42 (Donors): HTTP 500',
    });

    const row = await env.DB.prepare('SELECT * FROM snapshot_runs WHERE id = ?1').bind(runId).first();
    expect(row).toMatchObject({ status: 'partial', error_count: 1, last_error: 'board 42 (Donors): HTTP 500' });
  });
});

describe('D1SnapshotRunStore watchdog queries', () => {
  const ok = { status: 'success', boardCount: 1, docCount: 0, errorCount: 0, lastError: null } as const;

  it('abandonStaleRuns marks only running rows started before the cutoff, and counts them as failures', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    const stale = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    const fresh = await store.recordRunStart('2026-08-25T10:30:00.000Z');
    const done = await store.recordRunStart('2026-08-25T08:00:00.000Z');
    await store.recordRunFinish(done, '2026-08-25T08:05:00.000Z', ok);

    const abandoned = await store.abandonStaleRuns('2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z');
    expect(abandoned).toEqual([{ id: stale, startedAt: '2026-08-25T09:00:00.000Z' }]);

    const { results } = await env.DB.prepare('SELECT id, status, finished_at, last_error FROM snapshot_runs').all<{
      id: number;
      status: string;
      finished_at: string | null;
      last_error: string | null;
    }>();
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get(stale)).toMatchObject({ status: 'abandoned', finished_at: '2026-08-25T11:00:00.000Z' });
    expect(byId.get(stale)!.last_error).toMatch(/never finished/);
    expect(byId.get(fresh)!.status).toBe('running');
    expect(byId.get(done)!.status).toBe('success');

    const alertState = await env.DB.prepare('SELECT consecutive_failures FROM run_alert_state WHERE id = 1').first<{
      consecutive_failures: number;
    }>();
    expect(alertState?.consecutive_failures).toBe(1);

    // Idempotent: a second sweep finds nothing new.
    expect(await store.abandonStaleRuns('2026-08-25T10:00:00.000Z', '2026-08-25T11:00:00.000Z')).toEqual([]);
  });

  it('lastSnapshotAt returns the latest success, ignoring partial and failed runs', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    expect(await store.lastSnapshotAt()).toBeNull();
    const a = await store.recordRunStart('2026-08-24T09:00:00.000Z');
    await store.recordRunFinish(a, '2026-08-24T09:05:00.000Z', ok);
    const b = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    await store.recordRunFinish(b, '2026-08-25T09:05:00.000Z', { ...ok, status: 'partial', errorCount: 1, lastError: 'x' });
    const c = await store.recordRunStart('2026-08-26T09:00:00.000Z');
    await store.recordRunFailure(c, '2026-08-26T09:01:00.000Z', 'boom');
    expect(await store.lastSnapshotAt()).toBe('2026-08-24T09:05:00.000Z');
  });

  it('recordRunStopped marks the run stopped, without touching the failure streak', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    const id = await store.recordRunStart('2026-08-25T09:00:00.000Z');
    await store.recordRunStopped(id, '2026-08-25T09:10:00.000Z', 'stopped by the write switch');
    const row = await env.DB.prepare('SELECT * FROM snapshot_runs WHERE id = ?').bind(id).first();
    expect(row).toMatchObject({ status: 'stopped', finished_at: '2026-08-25T09:10:00.000Z', last_error: 'stopped by the write switch' });
    const state = await env.DB.prepare('SELECT consecutive_failures FROM run_alert_state WHERE id = 1').first<{ consecutive_failures: number }>();
    expect(state?.consecutive_failures).toBe(0);
  });

  it('armWatchdog records the first arm time and keeps it', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    expect(await store.armWatchdog('2026-08-25T09:00:00.000Z')).toBe('2026-08-25T09:00:00.000Z');
    expect(await store.armWatchdog('2026-08-26T09:00:00.000Z')).toBe('2026-08-25T09:00:00.000Z');
  });

  it('records and returns the last stale alert time', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    expect(await store.lastStaleAlertAt()).toBeNull();
    await store.recordStaleAlert('2026-08-25T09:00:00.000Z');
    expect(await store.lastStaleAlertAt()).toBe('2026-08-25T09:00:00.000Z');
  });

  it('round-trips the last usage alert, null until one is recorded', async () => {
    const store = new D1SnapshotRunStore(env.DB);
    expect(await store.lastUsageAlert()).toBeNull();
    await store.recordUsageAlert('2026-10-27', 50);
    await store.recordUsageAlert('2026-10-27', 80);
    expect(await store.lastUsageAlert()).toEqual({ day: '2026-10-27', level: 80 });
  });
});
