import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runPairing } from './pairing';
import { validateConfig } from '../config';
import type { DonationItem, DtdMondayClient } from '../monday/client';
import { upsertRecord } from '../db/records';
import sandbox from '../../config/sandbox.json';

const config = validateConfig(sandbox);
const D = config.donations;
const NOW = new Date('2026-11-03T12:00:00Z');

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '1', amount: 100, date: '2026-09-01', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
const matchItem = (over: Partial<DonationItem> = {}) =>
  item({ id: '50', giftType: 'Matching Donation', date: '2026-10-01', matchedByItemId: '700', ...over });

async function seedCompany(itemId: string, company: string): Promise<void> {
  await upsertRecord(env.DB, {
    donationIdentifier: `monday-${itemId}`, mondayItemId: itemId, source: null, status: null, matchingGiftStatus: null,
    employerStatus: null, companyId: null, companyName: company, matchedAmount: null, donationDatetime: null,
    updatedSeenAt: NOW.toISOString(), unmatched: false,
  });
}

function setup(items: DonationItem[], failOn?: string) {
  const writes: { id: string; values: Record<string, unknown> }[] = [];
  const monday: Partial<DtdMondayClient> = {
    listDonationsDatedSince: async () => items,
    listGiftsForDonor: async (donor) => items.filter((i) => i.donorItemId === donor),
    getOrganizationName: async () => 'Example Corp, Inc.',
    updateDonation: async (id, values) => {
      if (id === failOn) throw new Error('monday down');
      writes.push({ id, values });
    },
  };
  return { writes, deps: { monday: monday as DtdMondayClient, db: env.DB, config } };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM dtd_records').run();
});

describe('runPairing', () => {
  it('marks the original gift Matched and links the match', async () => {
    await seedCompany('1', 'Example Corp');
    const { deps, writes } = setup([item(), matchItem()]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 1, review: 0 });
    expect(writes).toEqual([
      { id: '50', values: { [D.matchesGift]: { item_ids: [1] }, [D.matchPairing]: { label: 'Auto' } } },
      { id: '1', values: { [D.matchStatus]: { label: 'Matched' } } },
    ]);
  });

  it('never touches a Staff pairing', async () => {
    await seedCompany('1', 'Example Corp');
    const { deps, writes } = setup([item(), matchItem({ matchPairing: 'Staff' })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 0 });
    expect(writes).toEqual([]);
  });

  it('skips matches that already have a gift', async () => {
    const { deps, writes } = setup([item(), matchItem({ matchesGiftItemId: '1' })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 0 });
    expect(writes).toEqual([]);
  });

  it('flags Needs review once, then writes nothing on re-evaluation', async () => {
    const first = setup([matchItem()]);
    expect(await runPairing(first.deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(first.writes).toEqual([{ id: '50', values: { [D.matchPairing]: { label: 'Needs review' } } }]);
    const again = setup([matchItem({ matchPairing: 'Needs review' })]);
    expect(await runPairing(again.deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(again.writes).toEqual([]);
  });

  it('sends an anonymous match (no donor) to review', async () => {
    const { deps, writes } = setup([matchItem({ donorItemId: null })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(writes).toHaveLength(1);
  });

  it('continues past a failing Monday write', async () => {
    await seedCompany('1', 'Example Corp');
    const { deps, writes } = setup([item(), matchItem({ id: '50' }), matchItem({ id: '51', donorItemId: null })], '50');
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(writes.map((w) => w.id)).toEqual(['51']);
  });
});
