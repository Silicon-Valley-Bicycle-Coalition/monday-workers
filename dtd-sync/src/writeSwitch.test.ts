import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { dryRunDb } from './writeSwitch';
import { DEFAULT_PII_KEYS, type SkipContext } from './flags';
import { setWatermark } from './db/state';

const ctx: SkipContext = {
  worker: 'dtd-sync', environment: 'sandbox', mode: 'off', logLevel: 'normal', deliveryId: 'test', piiKeys: DEFAULT_PII_KEYS,
};

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
});
afterEach(() => vi.restoreAllMocks());

describe('dryRunDb', () => {
  it('passes SELECT statements through to the real database', async () => {
    await setWatermark(env.DB, '2026-11-01T00:00:00.000Z');
    const db = dryRunDb(env.DB, ctx);
    const row = await db.prepare('  select value from sync_state where key = ?').bind('watermark').first<{ value: string }>();
    expect(row?.value).toBe('2026-11-01T00:00:00.000Z');
    expect(logs).toEqual([]);
  });

  it('logs and drops a write, resolving an empty success result', async () => {
    const db = dryRunDb(env.DB, ctx);
    const result = await db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').bind('dry', 'x').run();
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'dry'").first()).toBeNull();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ writeSwitch: 'skipped', sink: 'D1', operation: 'INSERT', args: 2 });
  });

  it('drops UPDATE and DELETE through all()/first() too', async () => {
    const db = dryRunDb(env.DB, ctx);
    expect((await db.prepare('UPDATE sync_state SET value = ?').bind('y').all()).results).toEqual([]);
    expect(await db.prepare('DELETE FROM sync_state').first()).toBeNull();
    expect(logs.map((l) => JSON.parse(l).operation)).toEqual(['UPDATE', 'DELETE']);
  });

  it('batch drops writes, runs reads, and returns one result per statement', async () => {
    await setWatermark(env.DB, 'seen');
    const db = dryRunDb(env.DB, ctx);
    const results = await db.batch([
      db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').bind('b', '1'),
      db.prepare('SELECT value FROM sync_state WHERE key = ?').bind('watermark'),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.results).toEqual([]);
    expect(results[1]!.results).toEqual([{ value: 'seen' }]);
    expect(await env.DB.prepare("SELECT value FROM sync_state WHERE key = 'b'").first()).toBeNull();
    expect(logs).toHaveLength(1);
  });
});
