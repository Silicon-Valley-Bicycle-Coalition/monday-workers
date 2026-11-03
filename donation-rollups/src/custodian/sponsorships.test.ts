import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runSponsorshipsBackfill } from './sponsorships';
import { BACKFILL_PER_RUN } from './membership';
import type { CustodianDeps, CustodianMondayClient } from './custodian';
import { D1GiftsStore } from '../db/gifts';
import { D1PendingStore } from '../db/pending';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import { D1RollCallCreditsStore } from '../db/rollCallCredits';
import type { DonationRollupsConfig, SponsorshipsConfig } from '../types';

const OWNER_COLS = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c', thisYearCount: 'c',
  lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c' };

function sponsorships(over: Partial<SponsorshipsConfig> = {}): SponsorshipsConfig {
  return { organizationsBoardId: 5, giftTypes: ['Sponsorship'], inKindGiftTypes: ['In-Kind'], yearBasis: 'calendar', windowYears: 3, pipelineBoards: {}, ...over };
}
function config(s: SponsorshipsConfig | null): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null, annualSummaryBoardId: null, annualSummaryColumns: null },
    affiliations: null,
    donationRollups: {
      donationBoards: [
        { boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: null, actingForLink: null, classification: null, sponsorshipCycle: 'cyc', inKindValue: 'ikv' } },
        { boardId: 101, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: null, actingForLink: null, classification: null, sponsorshipCycle: 'cyc2', inKindValue: null } },
      ],
      receivedStatusLabel: 'Received', ownerColumnsByBoard: { b1: OWNER_COLS }, membership: null, donorLevel: null,
      volunteerBoards: [], historicalVolunteerBoards: [], recurringGifts: null, rollCall: null, sponsorships: s,
    },
  };
}

function deps(text: Record<string, Record<string, string | null>>, s: SponsorshipsConfig | null, calls: string[][] = []): CustodianDeps {
  const client = {
    async getItemsColumnsText(ids: string[], columnIds: string[]) {
      calls.push([...ids]);
      const out = new Map<string, Map<string, string | null>>();
      for (const id of ids) { const rec = text[id]; if (rec) out.set(id, new Map(columnIds.map((c) => [c, rec[c] ?? null]))); }
      return out;
    },
  } as unknown as CustodianMondayClient;
  return { gifts: new D1GiftsStore(env.DB), pending: new D1PendingStore(env.DB), volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), rollCallCredits: new D1RollCallCreditsStore(env.DB), mondayClient: client,
    queue: { sendBatch: async () => {} }, config: config(s), now: new Date('2026-11-02T10:00:00Z') };
}
const base = { ownerItemId: 'o-bf', ownerBoardId: 'b1', amountCents: 500, giftDateISO: '2024-05-01', fiscalYear: 2024, status: 'Received' };
const find = async (id: string, owner = 'o-bf') => (await new D1GiftsStore(env.DB).giftsForOwner(owner)).find((g) => g.mondayItemId === id);

describe('sponsorships backfill duty', () => {
  it('backfills NULL facts for sponsorship and in-kind gifts only', async () => {
    await new D1GiftsStore(env.DB).refreshFacts([
      { ...base, mondayItemId: 'bf-s', giftType: 'Sponsorship' }, { ...base, mondayItemId: 'bf-k', giftType: 'In-Kind' },
      { ...base, mondayItemId: 'bf-d', giftType: 'Donation' }], 'import', 'now');
    const d = deps({ 'bf-s': { cyc: ' 2024 Summit ' }, 'bf-k': { cyc2: 'BTWD 2024', ikv: '$1,250.50' }, 'bf-d': { cyc: 'nope' } }, sponsorships());
    const report = await runSponsorshipsBackfill(d, d.now!);
    expect(report.ok).toBe(true);
    expect(report.detail).toEqual({ backfilled: 2, remaining: 0 });
    expect(await find('bf-s')).toMatchObject({ sponsorshipEvent: '2024 Summit', inKindValueCents: 0 });
    expect(await find('bf-k')).toMatchObject({ sponsorshipEvent: 'BTWD 2024', inKindValueCents: 125050 });
    expect(await find('bf-d')).toMatchObject({ sponsorshipEvent: null, inKindValueCents: null });
  });
  it("writes '' and 0 for blank cells so they aren't re-read", async () => {
    await new D1GiftsStore(env.DB).refreshFacts([
      { ...base, ownerItemId: 'o-bl', mondayItemId: 'bl-1', giftType: 'Sponsorship' }, { ...base, ownerItemId: 'o-bl', mondayItemId: 'bl-gone', giftType: 'Sponsorship' }], 'import', 'now');
    const calls: string[][] = [];
    const d = deps({ 'bl-1': { cyc: '   ', ikv: null } }, sponsorships({ giftTypes: ['Sponsorship'], inKindGiftTypes: [] }), calls);
    await runSponsorshipsBackfill(d, d.now!);
    expect(await find('bl-1', 'o-bl')).toMatchObject({ sponsorshipEvent: '', inKindValueCents: 0 });
    expect(await find('bl-gone', 'o-bl')).toMatchObject({ sponsorshipEvent: '', inKindValueCents: 0 });
    calls.length = 0;
    const again = await runSponsorshipsBackfill(d, d.now!);
    expect(calls).toEqual([]);
    expect(again.detail).toEqual({ backfilled: 0, remaining: 0 });
  });
  it('stops at the per-run budget and reports remaining > 0', async () => {
    const rows = Array.from({ length: BACKFILL_PER_RUN + 3 }, (_, i) => ({ ...base, ownerItemId: 'o-big', mondayItemId: `big-${String(i).padStart(5, '0')}`, giftType: 'BigType' }));
    await new D1GiftsStore(env.DB).refreshFacts(rows, 'import', 'now');
    const d = deps({}, sponsorships({ giftTypes: ['BigType'], inKindGiftTypes: [] }));
    const first = await runSponsorshipsBackfill(d, d.now!);
    expect(first.detail).toEqual({ backfilled: BACKFILL_PER_RUN, remaining: 1 });
    const second = await runSponsorshipsBackfill(d, d.now!);
    expect(second.detail).toEqual({ backfilled: 3, remaining: 0 });
  }, 60_000);
  it('is a no-op reporting 0 when sponsorships is null', async () => {
    const report = await runSponsorshipsBackfill(deps({}, null), new Date('2026-11-02T10:00:00Z'));
    expect(report).toMatchObject({ ok: true, detail: { backfilled: 0, remaining: 0 } });
  });
});
