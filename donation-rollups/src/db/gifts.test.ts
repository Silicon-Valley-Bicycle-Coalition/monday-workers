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
    env.DB.prepare('DELETE FROM affiliations'),
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

  // Diff-only refresh (README "operational findings, 2026-09-17", fix 2): a recompute
  // re-asserts every gift of its owner, and a bulk edit recomputes a big owner once per
  // donation — writing every gift every time is what pushed D1 past the Free-tier daily
  // row-write cap on 09-03 and 09-09. Unchanged facts must cost zero writes.
  it('refreshFacts leaves a gift whose facts are unchanged untouched — no write, updated_at kept', async () => {
    const store = new D1GiftsStore(env.DB);
    const g = gift({ mondayItemId: 'g-same' });
    await store.refreshFacts([g], 'webhook', '2026-01-01T00:00:00Z');

    const result = await store.refreshFacts([g], 'webhook', '2026-01-02T00:00:00Z');

    expect(result).toEqual({ changed: 0 });
    const row = await env.DB.prepare(`SELECT updated_at FROM gifts WHERE monday_item_id='g-same'`).first();
    expect(row).toEqual({ updated_at: '2026-01-01T00:00:00Z' });
  });

  it('refreshFacts writes only the gifts whose facts changed', async () => {
    const store = new D1GiftsStore(env.DB);
    const a = gift({ mondayItemId: 'g-a', amountCents: 100 });
    const b = gift({ mondayItemId: 'g-b', amountCents: 200 });
    await store.refreshFacts([a, b], 'webhook', '2026-01-01T00:00:00Z');

    const result = await store.refreshFacts([{ ...a, status: 'Failed' }, b], 'webhook', '2026-01-02T00:00:00Z');

    expect(result).toEqual({ changed: 1 });
    const rows = await env.DB.prepare(`SELECT monday_item_id, status, updated_at FROM gifts ORDER BY monday_item_id`).all();
    expect(rows.results).toEqual([
      { monday_item_id: 'g-a', status: 'Failed', updated_at: '2026-01-02T00:00:00Z' },
      { monday_item_id: 'g-b', status: 'Received', updated_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('refreshFacts treats an absent giftType as "keep stored" — not a change — but a different one as a change', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([gift({ mondayItemId: 'g-type', giftType: 'Membership' })], 'import', '2026-01-01T00:00:00Z');

    expect(await store.refreshFacts([gift({ mondayItemId: 'g-type' })], 'webhook', '2026-01-02T00:00:00Z')).toEqual({ changed: 0 });
    expect(await store.refreshFacts([gift({ mondayItemId: 'g-type', giftType: null })], 'webhook', '2026-01-02T00:00:00Z')).toEqual({ changed: 0 });

    expect(await store.refreshFacts([gift({ mondayItemId: 'g-type', giftType: 'Donation' })], 'webhook', '2026-01-03T00:00:00Z')).toEqual({ changed: 1 });
    const row = await env.DB.prepare(`SELECT gift_type, source, updated_at FROM gifts WHERE monday_item_id='g-type'`).first();
    expect(row).toEqual({ gift_type: 'Donation', source: 'webhook', updated_at: '2026-01-03T00:00:00Z' });
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
      fiscalYear: 2020, status: 'Received', giftType: 'Donation', actingForItemId: null, archived: true,
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

describe('D1GiftsStore — acting_for', () => {
  it('refreshFacts writes acting_for for active gifts, keeps it for archived ones, ignores undefined', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 'g-active', actingForItemId: 'af-1' }),
      gift({ mondayItemId: 'g-archived', actingForItemId: 'af-1' }),
    ], 'import', '2026-01-01T00:00:00Z');
    await store.markArchived(['g-archived'], '2026-01-02T00:00:00Z');
    // A later webhook recompute: Monday reads the archived item's relation as empty (null),
    // and the active item was cleared by staff (null too).
    await store.refreshFacts([
      gift({ mondayItemId: 'g-active', actingForItemId: null }),
      gift({ mondayItemId: 'g-archived', actingForItemId: null }),
    ], 'webhook', '2026-01-03T00:00:00Z');
    expect(await store.actingForByIds(['g-active', 'g-archived'])).toEqual(new Map([['g-active', null], ['g-archived', 'af-1']]));
    // A later refreshFacts with a non-null value for an archived row is rejected: archived items
    // never rewrite their history, even when a new value is supplied.
    await store.refreshFacts([gift({ mondayItemId: 'g-archived', actingForItemId: 'af-other' })], 'webhook', '2026-01-03T00:00:00Z');
    expect((await store.actingForByIds(['g-archived'])).get('g-archived')).toBe('af-1');
    // undefined (column not configured) never touches the stored value.
    await store.refreshFacts([gift({ mondayItemId: 'g-archived' })], 'webhook', '2026-01-04T00:00:00Z');
    expect((await store.actingForByIds(['g-archived'])).get('g-archived')).toBe('af-1');
  });

  it('attributedTotals sums Received gifts acting for one affiliation, newest date wins', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      gift({ mondayItemId: 'a1', actingForItemId: 'af-1', amountCents: 50000, giftDateISO: '2024-02-02' }),
      gift({ mondayItemId: 'a2', actingForItemId: 'af-1', amountCents: 2500, giftDateISO: '2025-05-05' }),
      gift({ mondayItemId: 'a3', actingForItemId: 'af-1', amountCents: 999, giftDateISO: '2025-06-06', status: 'Received (Historical)' }),
      gift({ mondayItemId: 'a4', actingForItemId: 'af-2', amountCents: 100 }),
    ], 'import', '2026-01-01T00:00:00Z');
    expect(await store.attributedTotals('af-1', 'Received')).toEqual({ cents: 52500, count: 2, lastGiftDateISO: '2025-05-05' });
    expect(await store.attributedTotals('af-none', 'Received')).toEqual({ cents: 0, count: 0, lastGiftDateISO: null });
  });

  it('organizationalGivingTotals sums across every affiliation that belongs to the person', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-1','b1','Ada @ Beta','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-9','p-9','b1','Bo @ Acme','2026-01-01T00:00:00Z')`),
    ]);
    await store.refreshFacts([
      gift({ mondayItemId: 'o1', actingForItemId: 'af-1', amountCents: 50000 }),
      gift({ mondayItemId: 'o2', actingForItemId: 'af-2', amountCents: 7500 }),
      gift({ mondayItemId: 'o3', actingForItemId: 'af-9', amountCents: 100 }),
      gift({ mondayItemId: 'o4', actingForItemId: 'af-1', amountCents: 5, status: 'Failed' }),
    ], 'import', '2026-01-01T00:00:00Z');
    expect(await store.organizationalGivingTotals('p-1', 'Received')).toEqual({ cents: 57500, count: 2 });
    expect(await store.organizationalGivingTotals('p-none', 'Received')).toEqual({ cents: 0, count: 0 });
  });

  it('attributedTotalsAll and organizationalGivingAll aggregate every affiliation/person in one pass — reconcile legs 5/6', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-1','p-1','b1','Ada @ Acme','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-2','p-1','b1','Ada @ Beta','2026-01-01T00:00:00Z')`),
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-9','p-9','b1','Bo @ Acme','2026-01-01T00:00:00Z')`),
    ]);
    await store.refreshFacts([
      gift({ mondayItemId: 'o1', actingForItemId: 'af-1', amountCents: 50000 }),
      gift({ mondayItemId: 'o2', actingForItemId: 'af-2', amountCents: 7500 }),
      gift({ mondayItemId: 'o3', actingForItemId: 'af-9', amountCents: 100 }),
      gift({ mondayItemId: 'o4', actingForItemId: 'af-1', amountCents: 5, status: 'Failed' }),
    ], 'import', '2026-01-01T00:00:00Z');

    expect(await store.attributedTotalsAll('Received')).toEqual(new Map([
      ['af-1', { cents: 50000, count: 1 }],
      ['af-2', { cents: 7500, count: 1 }],
      ['af-9', { cents: 100, count: 1 }],
    ]));
    expect(await store.organizationalGivingAll('Received')).toEqual(new Map([
      ['p-1', { cents: 57500, personBoardId: 'b1' }],
      ['p-9', { cents: 100, personBoardId: 'b1' }],
    ]));
  });
});
