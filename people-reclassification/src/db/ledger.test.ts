import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './ledger';

describe('D1Ledger', () => {
  let ledger: D1Ledger;
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    ledger = new D1Ledger(env.DB);
  });

  it('starts a run once; a second start returns the existing row', async () => {
    const first = await ledger.startRun({ runId: 'r1', trigger: 'quarterly', dryRun: true, startedAt: '2026-10-01T10:00:00Z' });
    expect(first).toEqual({ created: true, existing: null });
    const again = await ledger.startRun({ runId: 'r1', trigger: 'quarterly', dryRun: true, startedAt: '2026-10-01T11:00:00Z' });
    expect(again.created).toBe(false);
    expect(again.existing?.status).toBe('running');
    expect(again.existing?.dryRun).toBe(true);
  });

  it('finishes a run with its summary and lists runs newest first', async () => {
    await ledger.startRun({ runId: 'r1', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    await ledger.startRun({ runId: 'r2', trigger: 'http', dryRun: true, startedAt: '2026-10-02T10:00:00Z' });
    await ledger.finishRun('r1', 'ok', '2026-10-01T10:05:00Z', { remaining: 3 });
    const runs = await ledger.recentRuns(10);
    expect(runs.map((r) => r.runId)).toEqual(['r2', 'r1']);
    expect(runs[1]?.summary).toEqual({ remaining: 3 });
    expect(await ledger.lastRun({ dryRun: false })).toMatchObject({ runId: 'r1', status: 'ok' });
    expect(await ledger.lastRun({ trigger: 'threshold' })).toBeNull();
  });

  it('can skip operator previews (HTTP dry runs) but keeps cron dry runs and live HTTP runs', async () => {
    await ledger.startRun({ runId: 'cron-dry', trigger: 'quarterly', dryRun: true, startedAt: '2026-10-01T10:00:00Z' });
    await ledger.startRun({ runId: 'http-live', trigger: 'http', dryRun: false, startedAt: '2026-10-02T10:00:00Z' });
    await ledger.startRun({ runId: 'preview', trigger: 'http', dryRun: true, startedAt: '2026-10-03T10:00:00Z' });
    expect(await ledger.lastRun()).toMatchObject({ runId: 'preview' });
    expect(await ledger.lastRun({ passesOnly: true })).toMatchObject({ runId: 'http-live' });
    await env.DB.prepare("DELETE FROM runs WHERE run_id = 'http-live'").run();
    expect(await ledger.lastRun({ passesOnly: true })).toMatchObject({ runId: 'cron-dry' });
  });

  it('passesOnly skips the promote sweep and the logged-contact run too', async () => {
    const ledger = new D1Ledger(env.DB);
    await ledger.startRun({ runId: 'pass', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T00:00:00Z' });
    await ledger.startRun({ runId: 'sweep', trigger: 'promote-sweep', dryRun: false, startedAt: '2026-10-02T00:00:00Z' });
    await ledger.startRun({ runId: 'logged', trigger: 'logged-contact', dryRun: false, startedAt: '2026-10-03T00:00:00Z' });
    expect(await ledger.lastRun({ passesOnly: true })).toMatchObject({ runId: 'pass' });
  });

  it('passesOnly also skips single-person moves, which must not stop a continuation or use up a pass', async () => {
    await ledger.startRun({ runId: 'pass', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    await ledger.startRun({ runId: 'one', trigger: 'single-move', dryRun: false, startedAt: '2026-10-02T10:00:00Z' });
    expect(await ledger.lastRun()).toMatchObject({ runId: 'one' });
    expect(await ledger.lastRun({ passesOnly: true })).toMatchObject({ runId: 'pass' });
  });

  it('records moves, advances their status, and lists only the unsettled ones', async () => {
    await ledger.startRun({ runId: 'r1', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    const base = { runId: 'r1', fromBoardId: '1', toBoardId: '2', direction: 'to-historical' as const, latestActivity: '2015-01-01', reason: 'aged-out', plannedAt: '2026-10-01T10:00:00Z' };
    const a = await ledger.insertMove({ ...base, itemId: 'a', status: 'planned' });
    const b = await ledger.insertMove({ ...base, itemId: 'b', status: 'planned' });
    const c = await ledger.insertMove({ ...base, itemId: 'c', status: 'dry-run' });
    await ledger.setMoveStatus(a, 'moved', '2026-10-01T10:00:01Z');
    await ledger.setMoveStatus(b, 'ambiguous', '2026-10-01T10:00:02Z', 'timed out');
    const unsettled = await ledger.unsettledMoves();
    expect(unsettled.map((m) => [m.itemId, m.status, m.error])).toEqual([['b', 'ambiguous', 'timed out']]);
    expect(c).toBeGreaterThan(b);
    const moved = await env.DB.prepare('SELECT moved_at FROM moves WHERE id = ?').bind(a).first<{ moved_at: string }>();
    expect(moved?.moved_at).toBe('2026-10-01T10:00:01Z');
  });

  it('refuses the same item twice in one run', async () => {
    await ledger.startRun({ runId: 'r1', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });
    const m = { runId: 'r1', itemId: 'a', fromBoardId: '1', toBoardId: '2', direction: 'to-live' as const, latestActivity: null, reason: 'lifetime-member', status: 'planned' as const, plannedAt: 'now' };
    await ledger.insertMove(m);
    await expect(ledger.insertMove(m)).rejects.toThrow();
  });

  it('remembers the last alert per board and kind', async () => {
    expect(await ledger.lastAlertAt('2', 'historical-capacity')).toBeNull();
    await ledger.recordAlert('2', 'historical-capacity', '2026-10-01T10:00:00Z', 'it-1');
    await ledger.recordAlert('2', 'historical-capacity', '2026-11-01T10:00:00Z', null);
    expect(await ledger.lastAlertAt('2', 'historical-capacity')).toBe('2026-11-01T10:00:00Z');
    expect(await ledger.lastAlertAt('3', 'historical-capacity')).toBeNull();
  });

  it('leases one pass at a time: held until released or expired, and only its holder releases it', async () => {
    expect(await ledger.acquireLease('a', '2026-10-09T17:00:00Z', '2026-10-09T17:30:00Z')).toBe(true);
    expect(await ledger.acquireLease('b', '2026-10-09T17:10:00Z', '2026-10-09T17:40:00Z')).toBe(false);
    await ledger.releaseLease('b');
    expect(await ledger.acquireLease('b', '2026-10-09T17:10:00Z', '2026-10-09T17:40:00Z')).toBe(false);
    expect(await ledger.acquireLease('b', '2026-10-09T17:30:00Z', '2026-10-09T18:00:00Z')).toBe(true);
    await ledger.releaseLease('a');
    expect(await ledger.acquireLease('c', '2026-10-09T17:31:00Z', '2026-10-09T18:01:00Z')).toBe(false);
    await ledger.releaseLease('b');
    expect(await ledger.acquireLease('c', '2026-10-09T17:31:00Z', '2026-10-09T18:01:00Z')).toBe(true);
  });
});
