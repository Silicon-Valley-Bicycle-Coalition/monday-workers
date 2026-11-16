import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from './reset';

describe('D1 schema', () => {
  beforeEach(resetDb);

  it('stores a match and a proposal', async () => {
    await env.DB.prepare(
      `INSERT INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
       VALUES ('1', '10', '20', '2026-01-01', 5000, 'board', '2026-11-16T00:00:00Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at)
       VALUES ('10', '20', '30', 'Current', 2, '2026-11-16T00:00:00Z')`,
    ).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM matches').first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT proposed_status FROM proposals').first<{ proposed_status: string }>())?.proposed_status).toBe('Current');
  });

  it('refuses a second proposal for the same person and organization', async () => {
    const insert = `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at)
                    VALUES ('10', '20', ?, 'Former', 2, '2026-11-16T00:00:00Z')`;
    await env.DB.prepare(insert).bind('30').run();
    await expect(env.DB.prepare(insert).bind('31').run()).rejects.toThrow();
  });

  it('INSERT OR IGNORE keeps one row per donation item', async () => {
    const insert = `INSERT OR IGNORE INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
                    VALUES ('1', '10', '20', '2026-01-01', NULL, 'bootstrap', '2026-11-16T00:00:00Z')`;
    await env.DB.prepare(insert).run();
    await env.DB.prepare(insert).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM matches').first<{ n: number }>())?.n).toBe(1);
  });
});
