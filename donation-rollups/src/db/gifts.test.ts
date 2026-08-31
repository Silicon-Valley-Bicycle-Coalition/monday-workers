import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1GiftsStore, type GiftFact } from './gifts';

// The aggregate queries here (ownerTotals, fiscalYearTotals, getAnnualSummaries) read the
// whole table, so unlike the id-scoped stores this file must start each test clean.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM gifts'),
    env.DB.prepare('DELETE FROM annual_summaries'),
    env.DB.prepare('DELETE FROM custodian_runs'),
  ]);
});

const gift = (over: Partial<GiftFact>): GiftFact => ({
  mondayItemId: `g-${Math.random().toString(36).slice(2)}`, ownerItemId: 'o1', ownerBoardId: 'b1',
  amountCents: 1000, giftDateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', ...over,
});

describe('D1GiftsStore', () => {
  it('refreshFacts inserts, then updates on re-assertion while preserving provenance', async () => {
    const store = new D1GiftsStore(env.DB);
    const g = gift({ mondayItemId: 'g-keep' });
    await store.refreshFacts([g], 'webhook', '2026-01-01T00:00:00Z');
    // Simulate bootstrap-written provenance the webhook path can't see.
    await env.DB.prepare(`UPDATE gifts SET gift_type='Membership', sf_id='006x', archived_at='2026-01-02T00:00:00Z' WHERE monday_item_id='g-keep'`).run();

    await store.refreshFacts([{ ...g, amountCents: 2000 }], 'webhook', '2026-01-03T00:00:00Z');
    const row = await env.DB.prepare(`SELECT amount_cents, gift_type, sf_id, archived_at FROM gifts WHERE monday_item_id='g-keep'`).first();
    expect(row).toEqual({ amount_cents: 2000, gift_type: 'Membership', sf_id: '006x', archived_at: '2026-01-02T00:00:00Z' });
  });

  it('getArchivable lists only active gifts before the cutoff; markArchived removes them', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 'old-active', fiscalYear: 2015 }),
      gift({ mondayItemId: 'new-active', fiscalYear: 2026 }),
      gift({ mondayItemId: 'old-archived', fiscalYear: 2014 }),
    ], 'import', '2026-01-01T00:00:00Z');
    await store.markArchived(['old-archived'], '2026-01-01T00:00:00Z');

    expect(await store.getArchivable(2026)).toEqual([{ mondayItemId: 'old-active', fiscalYear: 2015 }]);
    await store.markArchived(['old-active'], '2026-01-02T00:00:00Z');
    expect(await store.getArchivable(2026)).toEqual([]);
  });

  it('ownerTotals sums Received cents per owner; fiscalYearTotals buckets by FY and type', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 't1', ownerItemId: 'oA', amountCents: 100, fiscalYear: 2019 }),
      gift({ mondayItemId: 't2', ownerItemId: 'oA', amountCents: 250, fiscalYear: 2020 }),
      gift({ mondayItemId: 't3', ownerItemId: 'oB', amountCents: 999, fiscalYear: 2019, status: 'Failed' }),
    ], 'import', '2026-01-01T00:00:00Z');
    await env.DB.prepare(`UPDATE gifts SET gift_type='Donation' WHERE monday_item_id='t1'`).run();

    const totals = await store.ownerTotals('Received');
    expect(totals.get('oA')).toEqual({ cents: 350, count: 2, ownerBoardId: 'b1' });
    expect(totals.has('oB')).toBe(false); // Failed gifts don't roll up

    const fy = await store.fiscalYearTotals('Received', 2021);
    expect(fy).toEqual([
      { fiscalYear: 2019, totalCents: 100, giftCount: 1, byTypeJson: JSON.stringify({ Donation: 100 }) },
      { fiscalYear: 2020, totalCents: 250, giftCount: 1, byTypeJson: JSON.stringify({ '(unknown)': 250 }) },
    ]);
  });

  it('upsertAnnualSummaries stamps restated_at only when a stored year CHANGES', async () => {
    const store = new D1GiftsStore(env.DB);
    const y2019 = { fiscalYear: 2019, totalCents: 100, giftCount: 1, byTypeJson: '{}' };
    expect((await store.upsertAnnualSummaries([y2019], '2026-01-01T00:00:00Z')).changed).toEqual([2019]);
    // Unchanged re-run: no restatement, no update.
    expect((await store.upsertAnnualSummaries([y2019], '2026-01-02T00:00:00Z')).changed).toEqual([]);
    // A changed closed year is an audit restatement.
    expect((await store.upsertAnnualSummaries([{ ...y2019, totalCents: 150 }], '2026-01-03T00:00:00Z')).changed).toEqual([2019]);
    const rows = await store.getAnnualSummaries();
    expect(rows[0]!.restatedAt).toBe('2026-01-03T00:00:00Z');
  });

  it('giftsForOwner joins deep-link board ids and reports archived state', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([gift({ mondayItemId: 'j1', ownerItemId: 'oJ', giftType: 'Donation' })], 'import', 'now');
    await store.markArchived(['j1'], 'now');
    await env.DB.prepare(`INSERT INTO donation_links (donation_item_id, donation_board_id, owner_item_id, owner_board_id, updated_at)
      VALUES ('j1', '100', 'oJ', 'b1', 'now')`).run();
    const rows = await store.giftsForOwner('oJ');
    expect(rows).toEqual([{
      mondayItemId: 'j1', donationBoardId: '100', amountCents: 1000, giftDateISO: '2020-01-15',
      fiscalYear: 2020, status: 'Received', giftType: 'Donation', archived: true,
    }]);
  });

  it('setSummaryItemId records the board item backing a fiscal year', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.upsertAnnualSummaries([{ fiscalYear: 2019, totalCents: 1, giftCount: 1, byTypeJson: '{}' }], 'now');
    await store.setSummaryItemId(2019, 'item-9');
    expect((await store.getAnnualSummaries())[0]!.mondayItemId).toBe('item-9');
  });

  it('records custodian runs and returns the latest per duty', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.recordRun({ duty: 'reconcile', ranAt: '2026-01-01T00:00:00Z', ok: true, report: { n: 1 } });
    await store.recordRun({ duty: 'reconcile', ranAt: '2026-01-02T00:00:00Z', ok: false, report: { n: 2 } });
    await store.recordRun({ duty: 'capacity', ranAt: '2026-01-01T12:00:00Z', ok: true, report: {} });
    const runs = await store.lastRuns();
    const reconcile = runs.find((r) => r.duty === 'reconcile')!;
    expect(reconcile.ranAt).toBe('2026-01-02T00:00:00Z');
    expect(reconcile.ok).toBe(false);
    expect(runs.find((r) => r.duty === 'capacity')!.ok).toBe(true);
  });
});
