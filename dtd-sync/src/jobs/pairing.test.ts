import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    updatedSeenAt: NOW.toISOString(), unmatched: false, donorEmailHash: null, donationAmount: null,
  });
}

function setup(items: DonationItem[], failOn?: string) {
  const writes: { id: string; values: Record<string, unknown> }[] = [];
  const monday: Partial<DtdMondayClient> = {
    listDonationsOfTypeDatedSince: async (type) => items.filter((i) => i.giftType === type),
    getDonations: async (ids) => items.filter((i) => ids.includes(i.id)),
    listGiftsForDonor: async (donor) => items.filter((i) => i.donorItemId === donor),
    getDonation: async (id) => items.find((i) => i.id === id) ?? null,
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
  await env.DB.prepare('DELETE FROM sync_state').run();
});
afterEach(() => vi.restoreAllMocks());

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

  it('skips matches that already have a gift (and writes nothing when the gift is already Matched)', async () => {
    const { deps, writes } = setup([item({ matchStatus: 'Matched' }), matchItem({ matchesGiftItemId: '1' })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 0 });
    expect(writes).toEqual([]);
  });

  it('flags Needs review once, then writes nothing on re-evaluation', async () => {
    const first = setup([matchItem()]);
    expect(await runPairing(first.deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(first.writes).toEqual([{ id: '50', values: { [D.matchPairing]: { label: 'Needs review' } } }]);
    const again = setup([matchItem({ matchPairing: 'Needs review' })]);
    expect(await runPairing(again.deps, new Date(NOW.getTime() + 24 * 3_600_000))).toEqual({ linked: 0, review: 1 }); // next daily sweep
    expect(again.writes).toEqual([]);
  });

  it('re-evaluates Needs-review matches once a day, not every hour', async () => {
    await seedCompany('1', 'Example Corp');
    const reviewed = () => matchItem({ matchPairing: 'Needs review' });
    const evaluated = (s: ReturnType<typeof setup>) => s.writes.some((w) => w.id === '50');
    const first = setup([item(), reviewed()]);
    await runPairing(first.deps, NOW); // first run sweeps
    expect(evaluated(first)).toBe(true);
    const hourLater = setup([item(), reviewed()]);
    await runPairing(hourLater.deps, new Date(NOW.getTime() + 3_600_000));
    expect(evaluated(hourLater)).toBe(false);
    const dayLater = setup([item(), reviewed()]);
    await runPairing(dayLater.deps, new Date(NOW.getTime() + 24 * 3_600_000));
    expect(evaluated(dayLater)).toBe(true);
  });

  it('evaluates a new match every run even between sweeps', async () => {
    await seedCompany('1', 'Example Corp');
    await runPairing(setup([]).deps, NOW); // starts the sweep clock
    const s = setup([item(), matchItem()]);
    await runPairing(s.deps, new Date(NOW.getTime() + 3_600_000));
    expect(s.writes.some((w) => w.id === '50')).toBe(true);
  });

  it('sends an anonymous match (no donor) to review', async () => {
    const { deps, writes } = setup([matchItem({ donorItemId: null })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(writes).toHaveLength(1);
  });

  it('sets the gift of a Staff-linked match to Matched', async () => {
    const { deps, writes } = setup([item(), matchItem({ matchPairing: 'Staff', matchesGiftItemId: '1' })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 0 });
    expect(writes).toEqual([{ id: '1', values: { [D.matchStatus]: { label: 'Matched' } } }]);
  });

  it('skips the self-heal when the linked gift is missing or off the Donations board', async () => {
    const { deps, writes } = setup([matchItem({ matchesGiftItemId: '404' })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 0 });
    expect(writes).toEqual([]);
  });

  it('heals a gift whose Matched write failed on an earlier run', async () => {
    await seedCompany('1', 'Example Corp');
    const first = setup([item(), matchItem()], '1');
    await runPairing(first.deps, NOW);
    expect(first.writes.map((w) => w.id)).toEqual(['50']); // link written, gift write failed

    const next = setup([item(), matchItem({ matchesGiftItemId: '1', matchPairing: 'Auto' })]);
    await runPairing(next.deps, NOW);
    expect(next.writes).toEqual([{ id: '1', values: { [D.matchStatus]: { label: 'Matched' } } }]);
  });

  it('sends a match with no amount to review rather than auto-linking by company', async () => {
    await seedCompany('1', 'Example Corp');
    const { deps, writes } = setup([item(), matchItem({ amount: null })]);
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(writes).toEqual([{ id: '50', values: { [D.matchPairing]: { label: 'Needs review' } } }]);
  });

  it('logs a failed match by item id with the message scrubbed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedCompany('1', 'Example Corp');
    const { deps } = setup([item(), matchItem()]);
    deps.monday.updateDonation = async () => { throw new Error('rejected for pat@example.org'); };
    await runPairing(deps, NOW);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('dtd-sync: pairing item 50 failed rejected for [email]');
    expect(lines.join('\n')).not.toContain('pat@example.org');
  });

  it('continues past a failing Monday write', async () => {
    await seedCompany('1', 'Example Corp');
    const { deps, writes } = setup([item(), matchItem({ id: '50' }), matchItem({ id: '51', donorItemId: null })], '50');
    expect(await runPairing(deps, NOW)).toEqual({ linked: 0, review: 1 });
    expect(writes.map((w) => w.id)).toEqual(['51']);
  });
});
