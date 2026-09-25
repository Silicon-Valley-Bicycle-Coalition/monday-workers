import { describe, it, expect, beforeEach } from 'vitest';
import { applyD1Migrations, env, reset } from 'cloudflare:test';

// Migrations run against databases that already hold data (the provisioned sandbox and
// production D1s), so each one that reshapes existing rows is exercised here from the state
// its predecessor left behind, not only from empty.
describe('migration 0002_unique_disbursement_id', () => {
  const upTo = (name: string) => env.TEST_MIGRATIONS.filter((m) => m.name < name);
  const run = (sql: string) => env.DB.prepare(sql).run();

  beforeEach(async () => {
    await reset();
  });

  it('merges existing duplicate Benevity disbursement ids, repointing their rows, then enforces uniqueness', async () => {
    await applyD1Migrations(env.DB, upTo('0002'));
    await run(`INSERT INTO uploads (id, monday_asset_id, uploaded_at) VALUES (1, 'a1', 't'), (2, 'a2', 't')`);
    // Upload 1 has blocks DUP (id 10) and '' (id 11, a header-error block); upload 2 re-uploaded
    // the same report as a new asset and got a second DUP row (id 20) plus another '' block (21).
    await run(
      `INSERT INTO disbursements (id, upload_id, disbursement_id, period_ending, currency) VALUES
         (10, 1, 'DUP', '2026-01-01', 'USD'), (11, 1, '', '', ''),
         (20, 2, 'DUP', '2026-01-01', 'USD'), (21, 2, '', '', '')`
    );
    await run(
      `INSERT INTO rows (transaction_id, disbursement_id, raw_row, ingested_at) VALUES
         ('T1', 10, '{}', 't'), ('T2', 20, '{}', 't')`
    );

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results: disbursements } = await env.DB
      .prepare(`SELECT id, upload_id, disbursement_id, block_index FROM disbursements ORDER BY id`)
      .all();
    expect(disbursements).toEqual([
      { id: 10, upload_id: 1, disbursement_id: 'DUP', block_index: 0 },
      { id: 11, upload_id: 1, disbursement_id: '', block_index: 1 },
      { id: 21, upload_id: 2, disbursement_id: '', block_index: 1 },
    ]);
    const { results: rows } = await env.DB.prepare(`SELECT transaction_id, disbursement_id FROM rows ORDER BY transaction_id`).all();
    expect(rows).toEqual([
      { transaction_id: 'T1', disbursement_id: 10 },
      { transaction_id: 'T2', disbursement_id: 10 },
    ]);

    await expect(
      run(`INSERT INTO disbursements (upload_id, disbursement_id, period_ending, currency) VALUES (2, 'DUP', 'x', 'USD')`)
    ).rejects.toThrow(/UNIQUE/);
    // Empty ids (unparseable headers) are not unique across blocks.
    await run(`INSERT INTO disbursements (upload_id, disbursement_id, period_ending, currency) VALUES (2, '', 'x', 'USD')`);
  });
});
