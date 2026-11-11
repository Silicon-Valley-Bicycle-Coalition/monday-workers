import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runSummary } from './summary';
import { validateConfig } from '../config';
import type { DonationItem, DtdMondayClient } from '../monday/client';
import { upsertRecord } from '../db/records';
import sandbox from '../../config/sandbox.json';

const config = validateConfig(sandbox);
const S = config.programSummary;
const NOW = new Date('2026-11-03T12:00:00Z');

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '1', amount: 100, date: '2026-09-01', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
const matchItem = (over: Partial<DonationItem> = {}) =>
  item({ id: '50', giftType: 'Matching Donation', amount: 40, date: '2026-10-01', matchedByItemId: '700', matchesGiftItemId: '1', ...over });

async function seed(id: string, datetime: string): Promise<void> {
  await upsertRecord(env.DB, {
    donationIdentifier: `monday-${id}`, mondayItemId: id, source: null, status: ':in-progress', matchingGiftStatus: null,
    employerStatus: ':complete', companyId: null, companyName: null, matchedAmount: null, donationDatetime: datetime,
    updatedSeenAt: NOW.toISOString(), unmatched: false, donorEmailHash: null, donationAmount: null,
  });
}

function setup(items: DonationItem[]) {
  const writes: { fy: string; values: Record<string, unknown> }[] = [];
  const monday: Partial<DtdMondayClient> = {
    listDonationsOfTypeDatedSince: async (type) => items.filter((i) => i.giftType === type),
    getDonations: async (ids) => items.filter((i) => ids.includes(i.id)),
    getDonation: async (id) => items.find((i) => i.id === id) ?? null,
    upsertProgramSummary: async (fy, values) => { writes.push({ fy, values }); },
  };
  return { writes, deps: { monday: monday as DtdMondayClient, db: env.DB, config } };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM dtd_records').run();
});

describe('runSummary', () => {
  it('runSummary upserts by Fiscal Year', async () => {
    await seed('1', '2026-09-01T00:00:00Z');
    await seed('2', '2026-05-01T00:00:00Z');
    const items = [item(), matchItem(), matchItem({ id: '40', date: '2026-03-01', matchesGiftItemId: null, matchedByItemId: '701', donorItemId: '901' })];
    const { deps, writes } = setup(items);
    await runSummary(deps, NOW);
    expect(writes.map((w) => w.fy)).toEqual(['FY2027', 'FY2026']);
    expect(writes[0]!.values).toEqual({
      [S.screened]: '1', [S.employerIdentified]: '1', [S.eligible]: '1', [S.submitted]: '1', [S.matchesPaid]: '1',
      [S.matchDollars]: '40.00', [S.matchedGiftDollars]: '100.00', [S.newMatchingCompanies]: '1',
      [S.firstTimeMatchedDonors]: '1', [S.asOf]: { date: '2026-11-03' },
    });
    expect(writes[1]!.values[S.matchesPaid]).toBe('1');
    expect(writes[1]!.values[S.screened]).toBe('1');
  });

  it('treats earlier matches as priors', async () => {
    const items = [item(), matchItem(), matchItem({ id: '40', date: '2026-03-01', matchesGiftItemId: null })];
    const { deps, writes } = setup(items);
    await runSummary(deps, NOW);
    expect(writes[0]!.values[S.newMatchingCompanies]).toBe('0');
    expect(writes[0]!.values[S.firstTimeMatchedDonors]).toBe('0');
  });
});
