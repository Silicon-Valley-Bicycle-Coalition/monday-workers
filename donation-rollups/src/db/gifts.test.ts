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
      fiscalYear: 2020, status: 'Received', giftType: 'Donation', actingForItemId: null, termStart: null, sponsorshipEvent: null, inKindValueCents: null, archived: true,
    }]);
  });

  it('markRemoved takes a gift out of every total and projection; a later refreshFacts restores it (issue #26)', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.prepare(`INSERT INTO affiliations (affiliation_item_id, person_item_id, person_board_id, name, updated_at)
      VALUES ('aff1', 'p1', 'pb', 'Acme', '2026-01-01')`).run();
    const kept = gift({ mondayItemId: 'g-kept', amountCents: 1000, actingForItemId: 'aff1' });
    const gone = gift({ mondayItemId: 'g-gone', amountCents: 5000, actingForItemId: 'aff1' });
    await store.refreshFacts([kept, gone], 'webhook', '2026-01-01T00:00:00Z');
    await env.DB.prepare(`UPDATE gifts SET sf_id='006gone' WHERE monday_item_id='g-gone'`).run();

    expect(await store.markRemoved('g-gone', '2026-02-01T00:00:00Z'))
      .toEqual({ ownerItemId: 'o1', ownerBoardId: 'b1', actingForItemId: 'aff1' });
    expect(await store.markRemoved('g-never', '2026-02-01T00:00:00Z')).toBeNull();

    expect((await store.giftsForOwner('o1')).map((g) => g.mondayItemId)).toEqual(['g-kept']);
    expect((await store.ownerTotals('Received')).get('o1')).toMatchObject({ cents: 1000, count: 1 });
    expect((await store.fiscalYearTotals('Received', 2100))[0]).toMatchObject({ totalCents: 1000, giftCount: 1 });
    expect(await store.attributedTotals('aff1', 'Received')).toMatchObject({ cents: 1000, count: 1 });
    expect(await store.organizationalGivingTotals('p1', 'Received')).toMatchObject({ cents: 1000, count: 1 });
    expect((await store.attributedTotalsAll('Received')).get('aff1')).toEqual({ cents: 1000, count: 1 });
    expect((await store.organizationalGivingAll('Received')).get('p1')).toMatchObject({ cents: 1000 });
    expect((await store.getArchivable(2100)).map((g) => g.mondayItemId)).toEqual(['g-kept']);

    // Restored on Monday (or re-linked): the next recompute re-asserts it, provenance intact.
    expect(await store.refreshFacts([gone], 'webhook', '2026-03-01T00:00:00Z')).toEqual({ changed: 1 });
    expect((await store.ownerTotals('Received')).get('o1')).toMatchObject({ cents: 6000, count: 2 });
    const row = await env.DB.prepare(`SELECT removed_at, sf_id FROM gifts WHERE monday_item_id='g-gone'`).first();
    expect(row).toEqual({ removed_at: null, sf_id: '006gone' });
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
      // Review finding 2: an affiliation with no gifts at all (its owner never gave, or every
      // gift moved off it) must still show up with a zero — not be silently absent.
      env.DB.prepare(`INSERT INTO affiliations VALUES ('af-empty','p-9','b1','Bo @ Empty','2026-01-01T00:00:00Z')`),
    ]);
    await store.refreshFacts([
      gift({ mondayItemId: 'o1', actingForItemId: 'af-1', amountCents: 50000 }),
      gift({ mondayItemId: 'o2', actingForItemId: 'af-2', amountCents: 7500 }),
      gift({ mondayItemId: 'o3', actingForItemId: 'af-9', amountCents: 100 }),
      gift({ mondayItemId: 'o4', actingForItemId: 'af-1', amountCents: 5, status: 'Failed' }),
      // A gift whose acting_for_item_id isn't in `affiliations` at all — a bootstrap gap, not
      // a ledger fact (see checkArtifactGuards) — must not appear on either side.
      gift({ mondayItemId: 'o5', actingForItemId: 'af-unknown', amountCents: 999999 }),
    ], 'import', '2026-01-01T00:00:00Z');

    expect(await store.attributedTotalsAll('Received')).toEqual(new Map([
      ['af-1', { cents: 50000, count: 1 }],
      ['af-2', { cents: 7500, count: 1 }],
      ['af-9', { cents: 100, count: 1 }],
      ['af-empty', { cents: 0, count: 0 }],
    ]));
    // p-9 has one gift-bearing affiliation (af-9) and one empty one (af-empty) — its total
    // is unaffected by the empty affiliation, but that affiliation still appears on its own
    // in attributedTotalsAll above.
    expect(await store.organizationalGivingAll('Received')).toEqual(new Map([
      ['p-1', { cents: 57500, personBoardId: 'b1' }],
      ['p-9', { cents: 100, personBoardId: 'b1' }],
    ]));
  });

  it('organizationalGivingAll keeps one total for a person whose affiliations name two boards', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-a','p-moved','b1','A','2026-01-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-b','p-moved','b2','B','2026-01-01T00:00:00Z')`).run();
    await store.refreshFacts([
      gift({ mondayItemId: 'g-a', amountCents: 5000, actingForItemId: 'af-a' }),
      gift({ mondayItemId: 'g-b', amountCents: 2500, actingForItemId: 'af-b' }),
    ], 'import', '2026-01-01T00:00:00Z');
    const row = (await store.organizationalGivingAll('Received')).get('p-moved');
    expect(row?.cents).toBe(7500);
    expect(await store.organizationalGivingTotals('p-moved', 'Received')).toMatchObject({ cents: 7500 });
  });

  it('a person whose affiliation(s) have no attributed gifts still appears with cents: 0 (finding 2)', async () => {
    const store = new D1GiftsStore(env.DB);
    await env.DB.prepare(`INSERT INTO affiliations VALUES ('af-lonely','p-lonely','b1','Lonely @ Org','2026-01-01T00:00:00Z')`).run();
    expect(await store.organizationalGivingAll('Received')).toEqual(new Map([
      ['p-lonely', { cents: 0, personBoardId: 'b1' }],
    ]));
  });
});

describe('term_start (membership activity rule)', () => {
  const base = { ownerItemId: 'o-ts', ownerBoardId: 'b1', amountCents: 500, giftDateISO: '2020-05-01', fiscalYear: 2020, status: 'Received' };
  it('refreshFacts stores a supplied termStart and leaves it alone when undefined', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'ts-1', termStart: '2020-05-01' }], 'import', 'now');
    await store.refreshFacts([{ ...base, mondayItemId: 'ts-1' }], 'webhook', 'later');
    expect((await store.giftsForOwner('o-ts')).find((g) => g.mondayItemId === 'ts-1')?.termStart).toBe('2020-05-01');
  });
  it('giftsMissingTermStart lists pre-cutover gifts never read, cursored; setTermStarts clears them, blank as ""', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      { ...base, mondayItemId: 'ts-a', giftDateISO: '2019-01-01' },
      { ...base, mondayItemId: 'ts-b', giftDateISO: '2019-02-01' },
      { ...base, mondayItemId: 'ts-c', giftDateISO: '2026-11-01' },   // post-cutover: never listed
    ], 'import', 'now');
    expect(await store.giftsMissingTermStart('2026-10-16', '', 10)).toEqual(expect.arrayContaining(['ts-a', 'ts-b']));
    expect(await store.giftsMissingTermStart('2026-10-16', 'ts-a', 10)).not.toContain('ts-a');
    await store.setTermStarts([{ mondayItemId: 'ts-a', termStart: '2019-01-01' }, { mondayItemId: 'ts-b', termStart: '' }], 'now');
    expect(await store.giftsMissingTermStart('2026-10-16', '', 10)).not.toEqual(expect.arrayContaining(['ts-a', 'ts-b']));
    const rows = await store.giftsForOwner('o-ts');
    expect(rows.find((g) => g.mondayItemId === 'ts-b')?.termStart).toBe('');
  });
  it('ownersOnBoards lists each owner with a live gift on the given boards once, skipping removed gifts and other boards', async () => {
    const store = new D1GiftsStore(env.DB);
    const g = { amountCents: 500, giftDateISO: '2020-05-01', fiscalYear: 2020, status: 'Received' };
    await store.refreshFacts([
      { ...g, mondayItemId: 'ob-1', ownerItemId: 'ob-p1', ownerBoardId: 'ob-20' },
      { ...g, mondayItemId: 'ob-2', ownerItemId: 'ob-p1', ownerBoardId: 'ob-20' },
      { ...g, mondayItemId: 'ob-3', ownerItemId: 'ob-p2', ownerBoardId: 'ob-28' },
      { ...g, mondayItemId: 'ob-4', ownerItemId: 'ob-gone', ownerBoardId: 'ob-20' },
      { ...g, mondayItemId: 'ob-5', ownerItemId: 'ob-org', ownerBoardId: 'ob-13' },
    ], 'import', 'now');
    await store.markRemoved('ob-4', 'later');
    const owners = await store.ownersOnBoards(['ob-20', 'ob-28']);
    expect(owners.sort((a, b) => (a.ownerItemId < b.ownerItemId ? -1 : 1))).toEqual([
      { ownerItemId: 'ob-p1', ownerBoardId: 'ob-20' }, { ownerItemId: 'ob-p2', ownerBoardId: 'ob-28' }]);
  });
  it('countedGifts lists live gifts from the given fiscal year on, leaving out removed gifts and earlier years', async () => {
    const store = new D1GiftsStore(env.DB);
    const g = { ownerItemId: 'cg-o', ownerBoardId: 'cg-b', amountCents: 700, status: 'Received' };
    await store.refreshFacts([
      { ...g, mondayItemId: 'cg-old', giftDateISO: '2025-01-01', fiscalYear: 2025 },
      { ...g, mondayItemId: 'cg-new', giftDateISO: '2026-01-01', fiscalYear: 2026, giftType: 'Individual' },
      { ...g, mondayItemId: 'cg-gone', giftDateISO: '2026-02-01', fiscalYear: 2026 },
    ], 'import', 'now');
    await store.markRemoved('cg-gone', 'later');
    expect(await store.countedGifts(2026)).toEqual([
      { mondayItemId: 'cg-new', ownerItemId: 'cg-o', fiscalYear: 2026, amountCents: 700, status: 'Received', giftType: 'Individual' }]);
  });
  it('countedGifts adds the named earlier-year gifts, once, never a removed one', async () => {
    const store = new D1GiftsStore(env.DB);
    const g = { ownerItemId: 'cx-o', ownerBoardId: 'cx-b', amountCents: 500_000, status: 'Received' };
    await store.refreshFacts([
      { ...g, mondayItemId: 'cx-prepaid', giftDateISO: '2025-02-17', fiscalYear: 2025 },
      { ...g, mondayItemId: 'cx-other', giftDateISO: '2025-03-01', fiscalYear: 2025 },
      { ...g, mondayItemId: 'cx-gone', giftDateISO: '2025-03-02', fiscalYear: 2025 },
      { ...g, mondayItemId: 'cx-new', giftDateISO: '2026-01-01', fiscalYear: 2026 },
    ], 'import', 'now');
    await store.markRemoved('cx-gone', 'later');
    const ids = (await store.countedGifts(2026, ['cx-prepaid', 'cx-gone', 'cx-new', 'cx-missing']))
      .map((r) => r.mondayItemId).filter((id) => id.startsWith('cx-'));
    expect(ids.sort()).toEqual(['cx-new', 'cx-prepaid']);
  });
});

describe('sponsorship facts (sponsorship_event, in_kind_value_cents)', () => {
  const base = { ownerItemId: 'o-sp', ownerBoardId: 'b1', amountCents: 500, giftDateISO: '2024-05-01', fiscalYear: 2024, status: 'Received' };
  const find = async (store: D1GiftsStore, id: string) => (await store.giftsForOwner('o-sp')).find((g) => g.mondayItemId === id);
  it('refreshFacts stores sponsorshipEvent and inKindValueCents', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sp-1', sponsorshipEvent: '2024 Summit', inKindValueCents: 25000 }], 'import', 'now');
    expect(await find(store, 'sp-1')).toMatchObject({ sponsorshipEvent: '2024 Summit', inKindValueCents: 25000 });
  });
  it('refreshFacts with them undefined leaves stored values', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sp-2', sponsorshipEvent: '2024 Summit', inKindValueCents: 100 }], 'import', 'now');
    await store.refreshFacts([{ ...base, mondayItemId: 'sp-2' }], 'webhook', 'later');
    expect(await find(store, 'sp-2')).toMatchObject({ sponsorshipEvent: '2024 Summit', inKindValueCents: 100 });
  });
  it('a changed sponsorshipEvent counts as a change', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sp-3', sponsorshipEvent: 'A', inKindValueCents: 0 }], 'import', 'now');
    expect(await store.refreshFacts([{ ...base, mondayItemId: 'sp-3', sponsorshipEvent: 'B', inKindValueCents: 0 }], 'webhook', 'later')).toEqual({ changed: 1 });
    expect(await store.refreshFacts([{ ...base, mondayItemId: 'sp-3', sponsorshipEvent: 'B', inKindValueCents: 0 }], 'webhook', 'later')).toEqual({ changed: 0 });
  });
  it('giftsForOwner returns null for never-read facts', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sp-4' }], 'import', 'now');
    expect(await find(store, 'sp-4')).toMatchObject({ sponsorshipEvent: null, inKindValueCents: null });
  });
  it('giftsMissingSponsorshipFacts returns only NULL rows of the given types, archived included, removed excluded, ordered by id after the cursor', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([
      { ...base, mondayItemId: 'sm-a', giftType: 'Sponsorship' },
      { ...base, mondayItemId: 'sm-b', giftType: 'Sponsorship' },
      { ...base, mondayItemId: 'sm-c', giftType: 'Sponsorship' },
      { ...base, mondayItemId: 'sm-d', giftType: 'Donation' },
      { ...base, mondayItemId: 'sm-e', giftType: 'Sponsorship', sponsorshipEvent: '', inKindValueCents: 0 },
      { ...base, mondayItemId: 'sm-f', giftType: 'Sponsorship' },
    ], 'import', 'now');
    await env.DB.prepare(`UPDATE gifts SET archived_at='2025-01-01' WHERE monday_item_id='sm-b'`).run();
    await store.markRemoved('sm-c', 'now');
    expect(await store.giftsMissingSponsorshipFacts(['Sponsorship'], '', 10)).toEqual(['sm-a', 'sm-b', 'sm-f']);
    expect(await store.giftsMissingSponsorshipFacts(['Sponsorship'], 'sm-a', 1)).toEqual(['sm-b']);
    expect(await store.giftsMissingSponsorshipFacts(['Sponsorship', 'Donation'], 'sm-b', 10)).toEqual(['sm-d', 'sm-f']);
    expect(await store.giftsMissingSponsorshipFacts([], '', 10)).toEqual([]);
  });
  it("setSponsorshipFacts writes '' and 0 so the row is no longer missing", async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sw-1', giftType: 'Sponsorship' }], 'import', 'now');
    await store.setSponsorshipFacts([{ mondayItemId: 'sw-1', sponsorshipEvent: '', inKindValueCents: 0 }], 'later');
    expect(await store.giftsMissingSponsorshipFacts(['Sponsorship'], '', 10)).toEqual([]);
    expect(await find(store, 'sw-1')).toMatchObject({ sponsorshipEvent: '', inKindValueCents: 0 });
  });
  it('setSponsorshipFacts leaves an already-stored value alone', async () => {
    const store = new D1GiftsStore(env.DB);
    await store.refreshFacts([{ ...base, mondayItemId: 'sw-2', giftType: 'Sponsorship', sponsorshipEvent: 'BTWD 2026' }], 'import', 'now');
    await store.setSponsorshipFacts([{ mondayItemId: 'sw-2', sponsorshipEvent: '', inKindValueCents: 500 }], 'later');
    expect(await find(store, 'sw-2')).toMatchObject({ sponsorshipEvent: 'BTWD 2026', inKindValueCents: 500 });
  });
});
