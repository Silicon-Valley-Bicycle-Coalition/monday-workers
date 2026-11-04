import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1AuthRetentionStore } from './authRetention';

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('D1AuthRetentionStore', () => {
  it('deletes login_attempts older than the cutoff and keeps newer ones', async () => {
    const store = new D1AuthRetentionStore(env.DB);
    for (const at of ['2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z', '2026-08-22T12:00:00.000Z']) {
      await env.DB.prepare('INSERT INTO login_attempts (email_hash, attempted_at) VALUES (?1, ?2)').bind('purge-a', at).run();
    }

    const deleted = await store.purgeLoginAttemptsBefore('2026-08-22T00:00:00.000Z');

    expect(deleted).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM login_attempts WHERE email_hash = 'purge-a'")).toBe(1);
  });

  it('deletes only sessions whose expiry has passed', async () => {
    const store = new D1AuthRetentionStore(env.DB);
    await env.DB.prepare('INSERT INTO sessions (session_hash, donor_item_ids, expires_at) VALUES (?1, ?2, ?3)')
      .bind('purge-s-old', '[]', '2026-08-21T00:00:00.000Z')
      .run();
    await env.DB.prepare('INSERT INTO sessions (session_hash, donor_item_ids, expires_at) VALUES (?1, ?2, ?3)')
      .bind('purge-s-live', '[]', '2026-08-23T00:00:00.000Z')
      .run();

    const deleted = await store.purgeSessionsExpiredBefore('2026-08-22T00:00:00.000Z');

    expect(deleted).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE session_hash LIKE 'purge-s-%'")).toBe(1);
  });

  // Used-but-unexpired tokens stay until expiry: consumeToken's UPDATE-then-SELECT must never
  // have its row deleted out from under it, and a used token is already inert (used_at set).
  it('deletes expired magic-link tokens, used or not, and keeps unexpired ones', async () => {
    const store = new D1AuthRetentionStore(env.DB);
    const insert = env.DB.prepare('INSERT INTO magic_link_tokens (token_hash, donor_item_ids, expires_at, used_at) VALUES (?1, ?2, ?3, ?4)');
    await insert.bind('purge-t-expired', '[]', '2026-08-21T00:00:00.000Z', null).run();
    await insert.bind('purge-t-expired-used', '[]', '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z').run();
    await insert.bind('purge-t-live-used', '[]', '2026-08-28T00:00:00.000Z', '2026-08-21T00:00:00.000Z').run();

    const deleted = await store.purgeMagicLinkTokensExpiredBefore('2026-08-22T00:00:00.000Z');

    expect(deleted).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM magic_link_tokens WHERE token_hash = 'purge-t-live-used'")).toBe(1);
  });

  // A months-long backlog (the first run after deploy) must not turn one cron invocation into an
  // unbounded delete: each run removes at most batchSize × maxBatches rows per table and the
  // next daily run picks up the rest.
  it('deletes in bounded batches and stops at maxBatches', async () => {
    const store = new D1AuthRetentionStore(env.DB, { batchSize: 2, maxBatches: 2 });
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare('INSERT INTO login_attempts (email_hash, attempted_at) VALUES (?1, ?2)').bind('purge-b', '2026-01-01T00:00:00.000Z').run();
    }

    expect(await store.purgeLoginAttemptsBefore('2026-08-22T00:00:00.000Z')).toBe(4);
    expect(await count("SELECT COUNT(*) AS n FROM login_attempts WHERE email_hash = 'purge-b'")).toBe(1);
    expect(await store.purgeLoginAttemptsBefore('2026-08-22T00:00:00.000Z')).toBe(1);
  });
});
