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
