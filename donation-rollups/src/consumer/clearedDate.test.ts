import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { env } from 'cloudflare:test';
import { processRecomputeBatch } from './processBatch';
import { D1GiftsStore } from '../db/gifts';
import { D1DonationLinksStore } from '../db/links';
import { D1PendingStore } from '../db/pending';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import { D1AffiliationsStore } from '../db/affiliations';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { HttpMondayClient } from '../monday/client';
import type { DonationRollupsConfig } from '../types';

// A gift entered as Received and then corrected to Pledged by clearing its Date. Run through the
// real D1 stores and the real Monday read: what matters is which items the read passes on.
const config: DonationRollupsConfig = {
  monday: { apiUrl: 'https://api.monday.test/v2', accountUrl: 'https://acme.monday.com' },
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  affiliations: { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } },
  donationRollups: {
    donationBoards: [{ boardId: 1, columns: { donorLink: 'donor', amount: 'amount', date: 'date', status: 'status',
      fiscalYear: null, actingForLink: 'acting_for', classification: null } }],
    receivedStatusLabel: 'Received',
    ownerColumnsByBoard: { '2': { giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
      thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
      largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg', lastGiftDate: 'lgd', lastGiftAmount: 'lga',
      organizationalGiving: 'og' } },
    membership: null, donorLevel: null, volunteerBoards: [], historicalVolunteerBoards: [],
    recurringGifts: null, rollCall: null, sponsorships: null,
  },
};

// date: null = Monday returned no Date cell at all.
interface BoardItem { state: string; amount: string; date: string | null; status: string; actingFor?: string }

describe('an active gift whose Date is cleared', () => {
  let board: Record<string, BoardItem>;
  let gifts: D1GiftsStore;
  let client: HttpMondayClient;
  let changeColumnValues: MockInstance<HttpMondayClient['changeColumnValues']>;

  // The board holds two Received gifts from one donor; each test edits gift '11' and recomputes.
  beforeEach(async () => {
    await env.DB.batch(['gifts', 'donation_links', 'pending_recomputes', 'owner_recomputes', 'owner_leases', 'affiliations']
      .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    board = {
      '10': { state: 'active', amount: '100', date: '2026-08-01', status: 'Received' },
      '11': { state: 'active', amount: '250', date: '2026-09-01', status: 'Received', actingFor: 'af-1' },
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { ids } = (JSON.parse(String(init.body)) as { variables: { ids: string[] } }).variables;
      const items = ids.filter((id) => board[id] !== undefined).map((id) => {
        const { state, amount, date, status, actingFor } = board[id]!;
        return { id, state, column_values: [
          { id: 'amount', text: amount, value: null }, ...(date === null ? [] : [{ id: 'date', text: date, value: null }]),
          { id: 'status', text: status, value: '{"index":1}' },
          { id: 'acting_for', text: '', value: null, linked_item_ids: actingFor && state === 'active' ? [actingFor] : [] },
        ] };
      });
      return new Response(JSON.stringify({ data: { items } }));
    }));
    client = new HttpMondayClient('https://api.monday.test/v2', 'token', { sleepFn: async () => {} });
    vi.spyOn(client, 'getDonorLinkWithBoard').mockResolvedValue({ ownerItemId: 'donor', ownerBoardId: '2', donationBoardId: '1' });
    vi.spyOn(client, 'getAffiliationSummary').mockResolvedValue({ name: 'A @ B', personItemId: 'person', personBoardId: '2', state: 'active' });
    vi.spyOn(client, 'setItemDescription').mockResolvedValue(undefined);
    changeColumnValues = vi.spyOn(client, 'changeColumnValues').mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    gifts = new D1GiftsStore(env.DB);
    await new D1DonationLinksStore(env.DB).bulkUpsert(Object.keys(board).map((donationItemId) =>
      ({ donationItemId, donationBoardId: '1', ownerItemId: 'donor', ownerBoardId: '2', updatedAt: '2026-01-01T00:00:00Z' })));
    await recompute('11');
    expect(await ledgerIds()).toEqual(['10', '11']);
    changeColumnValues.mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function recompute(donationItemId: string) {
    const message = { body: { donationItemId, donationBoardId: '1' }, ack: vi.fn(), retry: vi.fn() };
    await processRecomputeBatch([message], { pendingStore: new D1PendingStore(env.DB), linksStore: new D1DonationLinksStore(env.DB),
      giftsStore: gifts, volunteerStore: new D1VolunteerActivityStore(env.DB), recomputesStore: new D1OwnerRecomputesStore(env.DB),
      affiliationsStore: new D1AffiliationsStore(env.DB), mondayClient: client, config, now: new Date('2026-11-24T20:00:00Z') });
    return message;
  }
  const ledgerIds = async () => (await gifts.giftsForOwner('donor')).map((g) => g.mondayItemId).sort();
  const written = (itemId: string) => changeColumnValues.mock.calls.filter((c) => c[1] === itemId).at(-1)?.[2];

  it('leaves the ledger, its totals and the Gift Ledger JSON', async () => {
    board['11'] = { ...board['11']!, date: '', status: 'Pledged' };
    const message = await recompute('11');

    expect(await ledgerIds()).toEqual(['10']);
    expect((await gifts.ownerTotals('Received')).get('donor')).toMatchObject({ cents: 10_000, count: 1 });
    expect(written('donor')).toMatchObject({ lg: '100.00', gc: '1' });
    expect(String(written('donor')!['glj'])).not.toContain('2026-09-01');
    expect(message.ack).toHaveBeenCalled();
  });

  it('leaves the ledger whatever its Status says', async () => {
    board['11'] = { ...board['11']!, date: '' };
    await recompute('11');
    expect(await ledgerIds()).toEqual(['10']);
  });

  it('leaves the ledger when its Amount is blank too', async () => {
    board['11'] = { ...board['11']!, date: '', amount: '' };
    await recompute('11');
    expect(await ledgerIds()).toEqual(['10']);
  });

  it('leaves the affiliation and Organizational Giving totals it fed, even from another gift\'s recompute', async () => {
    board['11'] = { ...board['11']!, date: '', status: 'Pledged' };
    await recompute('10');
    expect(written('af-1')).toMatchObject({ n_ag: '0.00', n_agc: '0' });
    expect(written('person')).toEqual({ og: '0.00' });
  });

  it('retries the affiliation write when it failed after the row was marked removed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    board['11'] = { ...board['11']!, date: '', status: 'Pledged' };
    changeColumnValues.mockImplementation(async (_board, itemId) => { if (itemId === 'af-1') throw new Error('boom'); });
    const failed = await recompute('10');
    expect(failed.retry).toHaveBeenCalled();
    changeColumnValues.mockReset().mockResolvedValue(undefined);
    await recompute('10');
    expect(written('af-1')).toMatchObject({ n_ag: '0.00', n_agc: '0' });
  });

  it('comes back, with its provenance, once it has a Date again', async () => {
    await env.DB.prepare(`UPDATE gifts SET funraise_id = 'fr-1' WHERE monday_item_id = '11'`).run();
    board['11'] = { ...board['11']!, date: '', status: 'Pledged' };
    await recompute('11');
    expect(await ledgerIds()).toEqual(['10']);
    board['11'] = { ...board['11']!, date: '2026-11-20', status: 'Received' };
    await recompute('11');

    expect(await ledgerIds()).toEqual(['10', '11']);
    expect(written('donor')).toMatchObject({ lg: '350.00', gc: '2' });
    expect(await env.DB.prepare(`SELECT gift_date, funraise_id, removed_at FROM gifts WHERE monday_item_id = '11'`).first())
      .toEqual({ gift_date: '2026-11-20', funraise_id: 'fr-1', removed_at: null });
  });

  it('a pledge that was never in the ledger stays out of it', async () => {
    board['12'] = { state: 'active', amount: '500', date: '', status: 'Pledged' };
    await recompute('12');
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM gifts WHERE monday_item_id = '12'`).first()).toEqual({ n: 0 });
  });

  it.each([
    ['an archived gift with a blank Date', { state: 'archived', amount: '250', date: '', status: 'Received' }],
    ['a trashed gift with a blank Date', { state: 'deleted', amount: '250', date: '', status: 'Received' }],
    ['a gift whose Amount alone is blank', { state: 'active', amount: '', date: '2026-09-01', status: 'Received' }],
    ['a gift that read back without the Date column (retyped, or the item moved board)', { state: 'active', amount: '250', date: null, status: 'Received' }],
    ['a gift Monday did not return', undefined],
  ] as [string, BoardItem | undefined][])('keeps the stored row of %s', async (_label, item) => {
    if (item === undefined) delete board['11'];
    else board['11'] = item;
    await recompute('10');
    expect(await ledgerIds()).toEqual(['10', '11']);
  });
});
