import { describe, expect, it } from 'vitest';
import { rollUp, syncSection, type WatchdogSnapshot } from './syncs';
import type { SyncSpec } from './config';

const NOW = new Date('2026-11-20T18:41:00Z');
const RUN_AT = '2026-11-20T18:40:00.000Z';
const funraise: SyncSpec = { label: 'Funraise donations → Monday', description: 'd', worker: 'funraise-sync', queues: ['funraise-sync-writes'] };
const calendars: SyncSpec = { label: 'Website event calendars', description: 'd', worker: 'svbc-calendars', queues: [] };

type Sub = WatchdogSnapshot['subjects'][number];
const ok = (subject: string): Sub => ({ subject, status: 'ok' });
const bad = (subject: string, detail: string): Sub => ({ subject, status: 'bad', detail });
const snap = (...subjects: Sub[]): WatchdogSnapshot => ({ runAt: RUN_AT, subjects });
const healthy = [ok('cron:funraise-sync:0 * * * *'), ok('cron:funraise-sync:0 9 * * *'), ok('writes:funraise-sync'), ok('queue:funraise-sync-writes')];
const replace = (s: Sub) => healthy.map((h) => (h.subject === s.subject ? s : h));
const kv = (value: string | null) => ({ get: async (key: string) => (key === 'snapshot:latest' ? value : null) }) as unknown as KVNamespace;

describe('rollUp', () => {
  it('all ok is running', () =>
    expect(rollUp(funraise, snap(...healthy))).toEqual({ label: funraise.label, description: 'd', state: 'running', details: [], lastRunAt: null }));

  it('bad cron is not-running with lastRunAt', () => {
    const r = rollUp(funraise, snap(...replace(bad('cron:funraise-sync:0 * * * *', 'no run since 2026-11-20T14:00:00.000Z'))));
    expect(r.state).toBe('not-running');
    expect(r.lastRunAt).toBe('2026-11-20T14:00:00.000Z');
    expect(r.details).toEqual(['no run since 2026-11-20T14:00:00.000Z']);
  });

  it('bad cron with no run in the window has no lastRunAt', () =>
    expect(rollUp(funraise, snap(...replace(bad('cron:funraise-sync:0 * * * *', 'no run in the last 3 h')))).lastRunAt).toBeNull());

  it('bad queue is backed-up', () =>
    expect(rollUp(funraise, snap(...replace(bad('queue:funraise-sync-writes', '4 messages waiting, oldest 7.0 h')))).state).toBe('backed-up'));

  it('bad writes is paused', () => {
    const r = rollUp(funraise, snap(...replace(bad('writes:funraise-sync', 'writes are hold, expected on'))));
    expect(r.state).toBe('paused');
    expect(r.details).toEqual(['writes are hold, expected on']);
  });

  it('cron beats queue beats writes', () => {
    const all = snap(bad('cron:funraise-sync:0 * * * *', 'c'), bad('writes:funraise-sync', 'w'), bad('queue:funraise-sync-writes', 'q'));
    expect(rollUp(funraise, all).state).toBe('not-running');
    expect(rollUp(funraise, snap(ok('cron:funraise-sync:0 * * * *'), bad('writes:funraise-sync', 'w'), bad('queue:funraise-sync-writes', 'q'))).state).toBe('backed-up');
  });

  it('a bad state outranks a check-failed one', () =>
    expect(rollUp(funraise, snap(...replace(bad('writes:funraise-sync', 'w')).map((s) => (s.subject.startsWith('queue') ? { ...s, status: 'check-failed' as const } : s)))).state).toBe('paused'));

  it('missing subject is unknown', () =>
    expect(rollUp(funraise, snap(...healthy.filter((s) => !s.subject.startsWith('queue:')))).state).toBe('unknown'));

  it('worker with no subjects at all is unknown', () => expect(rollUp(funraise, snap(ok('writes:mailchimp-sync'))).state).toBe('unknown'));

  it('cron-only worker with no writes subject is running', () =>
    expect(rollUp(calendars, snap(ok('cron:svbc-calendars:0 13 * * *'))).state).toBe('running'));

  it('check-failed is unknown, with its error in details', () => {
    const r = rollUp(funraise, snap(...replace({ subject: 'queue:funraise-sync-writes', status: 'check-failed', detail: 'metrics down' })));
    expect(r.state).toBe('unknown');
    expect(r.details).toEqual(['metrics down']);
  });

  it("does not match another worker whose name shares a prefix", () =>
    expect(rollUp({ ...calendars, worker: 'member-map' }, snap(ok('cron:member-map-v2:0 1 * * *'))).state).toBe('unknown'));
});

describe('syncSection', () => {
  it('reads the snapshot and rolls up every spec', async () => {
    const s = await syncSection(kv(JSON.stringify(snap(...healthy))), [funraise], 2, NOW);
    expect(s).toEqual({ runAt: RUN_AT, stale: false, rows: [expect.objectContaining({ state: 'running' })] });
  });

  it('stale snapshot makes every row unknown', async () => {
    const old = { ...snap(...healthy), runAt: new Date(NOW.getTime() - (2 * 60 + 1) * 60_000).toISOString() };
    const s = await syncSection(kv(JSON.stringify(old)), [funraise], 2, NOW);
    expect(s.stale).toBe(true);
    expect(s.runAt).toBe(old.runAt);
    expect(s.rows).toEqual([expect.objectContaining({ state: 'unknown', details: [] })]);
  });

  it('missing key is stale with runAt null', async () => {
    const s = await syncSection(kv(null), [funraise], 2, NOW);
    expect(s).toMatchObject({ stale: true, runAt: null });
    expect(s.rows[0]!.state).toBe('unknown');
  });

  it('garbage JSON is stale', async () => {
    expect((await syncSection(kv('{not json'), [funraise], 2, NOW)).stale).toBe(true);
    expect((await syncSection(kv('{"runAt": 5}'), [funraise], 2, NOW)).stale).toBe(true);
  });

  it('a KV read error is stale, not a crash', async () => {
    const broken = { get: async () => { throw new Error('kv down'); } } as unknown as KVNamespace;
    expect((await syncSection(broken, [funraise], 2, NOW)).stale).toBe(true);
  });
});
