import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import migration from '../migrations/0001_create_sends.sql?raw';
import { claimSend, releaseSend } from './sendGuard';

// A minimal D1Database over node:sqlite, enough for prepare().bind().first()/run(), so the real
// SQL runs against the real migration instead of a hand-written fake.
function sqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const bound = (params: unknown[]) => ({
        async first() {
          return (stmt.get(...(params as never[])) as unknown) ?? null;
        },
        async run() {
          const result = stmt.run(...(params as never[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      });
      return { bind: (...params: unknown[]) => bound(params) };
    },
  } as unknown as D1Database;
}

const HOUR = 3_600_000;
const COOLDOWN = 24 * HOUR;
const T0 = 1_800_000_000_000;

describe('claimSend / releaseSend (#105)', () => {
  let db: D1Database;
  beforeEach(() => {
    db = sqliteD1();
  });

  it('claims an item that has never been sent', async () => {
    expect(await claimSend(db, 42, T0, COOLDOWN)).toBe(true);
  });

  it('refuses a second claim on the same item inside the cooldown', async () => {
    await claimSend(db, 42, T0, COOLDOWN);
    expect(await claimSend(db, 42, T0 + 1, COOLDOWN)).toBe(false);
    expect(await claimSend(db, 42, T0 + COOLDOWN - 1, COOLDOWN)).toBe(false);
  });

  it('claims again once the cooldown has passed, restarting it', async () => {
    await claimSend(db, 42, T0, COOLDOWN);
    expect(await claimSend(db, 42, T0 + COOLDOWN, COOLDOWN)).toBe(true);
    expect(await claimSend(db, 42, T0 + COOLDOWN + 1, COOLDOWN)).toBe(false);
  });

  it('keeps items independent', async () => {
    await claimSend(db, 42, T0, COOLDOWN);
    expect(await claimSend(db, 43, T0, COOLDOWN)).toBe(true);
  });

  it('a released claim (failed send) lets a retry through', async () => {
    await claimSend(db, 42, T0, COOLDOWN);
    await releaseSend(db, 42, T0);
    expect(await claimSend(db, 42, T0 + 1, COOLDOWN)).toBe(true);
  });

  it('release removes only its own claim, never a newer one', async () => {
    await claimSend(db, 42, T0, COOLDOWN);
    await claimSend(db, 42, T0 + COOLDOWN, COOLDOWN);
    await releaseSend(db, 42, T0); // a stale release from the first attempt
    expect(await claimSend(db, 42, T0 + COOLDOWN + 1, COOLDOWN)).toBe(false);
  });
});
