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

  it('records which evidence a proposal rests on, matches by default (#124)', async () => {
    await env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at)
       VALUES ('10', '20', '30', 'Current', 2, '2026-11-16T00:00:00Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at, evidence, domain)
       VALUES ('11', '20', '31', 'Current', 0, '2026-11-16T00:00:00Z', 'email_domain', 'acme.example')`,
    ).run();
    const rows = (await env.DB.prepare('SELECT person_item_id, evidence, domain FROM proposals ORDER BY person_item_id').all()).results;
    expect(rows).toEqual([
      { person_item_id: '10', evidence: 'matches', domain: null },
      { person_item_id: '11', evidence: 'email_domain', domain: 'acme.example' },
    ]);
  });

  it('refuses an unknown evidence kind', async () => {
    await expect(env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at, evidence)
       VALUES ('10', '20', '30', 'Current', 0, '2026-11-16T00:00:00Z', 'hunch')`,
    ).run()).rejects.toThrow();
  });

  it('holds one email_index row per address', async () => {
    const insert = `INSERT INTO email_index (address, kind, person_item_ids, affiliation_item_id) VALUES ('jo@acme.example', 'personal', '["1"]', NULL)`;
    await env.DB.prepare(insert).run();
    await expect(env.DB.prepare(insert).run()).rejects.toThrow();
  });
});
