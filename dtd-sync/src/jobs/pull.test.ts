import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runPull, type PullDeps } from './pull';
import { validateConfig } from '../config';
import { DtdAuthError } from '../dtd/client';
import type { DtdDonation } from '../dtd/types';
import type { DonationItem, DtdMondayClient, PersonItem } from '../monday/client';
import { getRecord, upsertRecord } from '../db/records';
import { getWatermark, setWatermark } from '../db/state';
import sandbox from '../../config/sandbox.json';

const config = validateConfig(sandbox);
const D = config.donations;
const P = config.people;
const NOW = new Date('2026-11-03T12:00:00Z');

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '500', amount: 50, date: '2026-10-01', status: 'Received', giftType: 'Donation', funraiseId: 'fr-1',
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
function dtd(over: Partial<DtdDonation> = {}): DtdDonation {
  return {
    donation_identifier: 'fr-1', source: null, donation_datetime: '2026-10-01T08:00:00-07:00',
    donor_email: 'pat@example.org', company_name: 'Example Corp', doublethedonation_company_id: 'c-7',
    status: ':waiting-for-donor-action', matching_gift_status: null, employer_identification_status: 'identified',
    matched_amount: null, plugin_link: 'https://example.org/match/abc', ...over,
  };
}

interface Harness {
  deps: PullDeps;
  fetched: { since: string; to: string }[];
  donationWrites: { id: string; values: Record<string, unknown> }[];
  personWrites: { id: string; values: Record<string, unknown> }[];
  lookups: string[];
  items: Map<string, DonationItem>;
  people: Map<string, PersonItem>;
  state: { donations: DtdDonation[]; failDonationWrite: boolean };
}

function harness(donations: DtdDonation[] = []): Harness {
  const h: Harness = {
    fetched: [], donationWrites: [], personWrites: [], lookups: [], items: new Map(), people: new Map(),
    state: { donations, failDonationWrite: false }, deps: undefined as unknown as PullDeps,
  };
  const monday: Partial<DtdMondayClient> = {
    findDonationByFunraiseId: async (id) => { h.lookups.push(`fr:${id}`); return [...h.items.values()].find((i) => i.funraiseId === id) ?? null; },
    findDonationBySalesforceId: async (id) => { h.lookups.push(`sf:${id}`); return [...h.items.values()].find((i) => i.salesforceId === id) ?? null; },
    getDonation: async (id) => { h.lookups.push(`id:${id}`); return h.items.get(id) ?? null; },
    getPeople: async (ids) => ids.flatMap((i) => h.people.get(i) ?? []),
    updateDonation: async (id, values) => {
      if (h.state.failDonationWrite) throw new Error('monday down');
      h.donationWrites.push({ id, values });
    },
    updatePerson: async (id, values) => { h.personWrites.push({ id, values }); },
  };
  h.deps = {
    dtd: { getUpdatedDonations: async (since, to) => { h.fetched.push({ since, to }); return h.state.donations; } },
    monday: monday as DtdMondayClient, db: env.DB, config,
  };
  return h;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM dtd_records').run();
  await env.DB.prepare('DELETE FROM sync_state').run();
});

describe('runPull', () => {
  it('writes Match Status, raw status and company for a Funraise record', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    const result = await runPull(h.deps, NOW);
    expect(result).toEqual({ fetched: 1, written: 1, unmatched: 0 });
    expect(h.donationWrites).toEqual([{
      id: '500',
      values: {
        [D.matchStatus]: { label: 'Waiting for donor' },
        [D.dtdStatusRaw]: ':waiting-for-donor-action',
        [D.matchCompany]: 'Example Corp',
      },
    }]);
    const rec = await getRecord(env.DB, 'fr-1');
    expect(rec).toMatchObject({ mondayItemId: '500', unmatched: false, companyName: 'Example Corp', donationDatetime: '2026-10-01T15:00:00.000Z' });
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());
  });

  it('prefers matching_gift_status over status for Match Status', async () => {
    const h = harness([dtd({ matching_gift_status: ':waiting-for-verification' })]);
    h.items.set('500', item());
    await runPull(h.deps, NOW);
    expect(h.donationWrites[0]!.values[D.matchStatus]).toEqual({ label: 'Submitted' });
  });

  it('resolves monday- identifiers to the item directly', async () => {
    const h = harness([dtd({ donation_identifier: 'monday-501', source: 'monday' })]);
    h.items.set('501', item({ id: '501', funraiseId: null }));
    await runPull(h.deps, NOW);
    expect(h.lookups).toEqual(['id:501']);
    expect(h.donationWrites.map((w) => w.id)).toEqual(['501']);
  });

  it('resolves other sources by Salesforce id', async () => {
    const h = harness([dtd({ donation_identifier: '006xx0000001', source: 'salesforce' })]);
    h.items.set('502', item({ id: '502', funraiseId: null, salesforceId: '006xx0000001' }));
    await runPull(h.deps, NOW);
    expect(h.lookups).toEqual(['sf:006xx0000001']);
    expect(h.donationWrites.map((w) => w.id)).toEqual(['502']);
  });

  it('skips the Monday write when nothing changed', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    await runPull(h.deps, NOW);
    h.donationWrites.length = 0;
    h.personWrites.length = 0;
    const second = await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(second).toEqual({ fetched: 1, written: 0, unmatched: 0 });
    expect(h.donationWrites).toEqual([]);
    expect(h.personWrites).toEqual([]);
  });

  it('writes again when the status changes', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    await runPull(h.deps, NOW);
    h.state.donations = [dtd({ status: ':ineligible' })];
    const second = await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(second.written).toBe(1);
    expect(h.donationWrites[1]!.values[D.matchStatus]).toEqual({ label: 'Not eligible' });
  });

  it('pull leaves unmatched records for the next run', async () => {
    const h = harness([dtd()]);
    const first = await runPull(h.deps, NOW);
    expect(first).toEqual({ fetched: 1, written: 0, unmatched: 1 });
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: null, unmatched: true });
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());

    h.state.donations = [];
    h.items.set('500', item());
    h.lookups.length = 0;
    const second = await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(h.lookups).toEqual(['fr:fr-1']);
    expect(second).toEqual({ fetched: 0, written: 1, unmatched: 0 });
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: false });
    expect(h.donationWrites[0]!.id).toBe('500');
  });

  it('does not move the watermark when a Monday write throws', async () => {
    await setWatermark(env.DB, '2026-11-01T00:00:00.000Z');
    const h = harness([dtd(), dtd({ donation_identifier: 'fr-2' })]);
    h.items.set('500', item());
    h.items.set('501', item({ id: '501', funraiseId: 'fr-2' }));
    h.state.failDonationWrite = true;
    await runPull(h.deps, NOW);
    expect(await getWatermark(env.DB)).toBe('2026-11-01T00:00:00.000Z');
    expect(await getRecord(env.DB, 'fr-1')).toBeNull();
    // The next run (Monday back up) re-handles it.
    h.state.failDonationWrite = false;
    await runPull(h.deps, NOW);
    expect(h.donationWrites).toHaveLength(2);
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());
  });

  it('uses the watermark minus the overlap, or 90 days back on the first run', async () => {
    const h = harness([]);
    await runPull(h.deps, NOW);
    expect(h.fetched[0]).toEqual({ since: new Date(NOW.getTime() - 90 * 86_400_000 - config.dtd.pullOverlapMinutes * 60_000).toISOString(), to: NOW.toISOString() });
    await setWatermark(env.DB, '2026-11-02T00:00:00.000Z');
    await runPull(h.deps, NOW);
    expect(h.fetched[1]!.since).toBe(new Date(Date.parse('2026-11-02T00:00:00.000Z') - config.dtd.pullOverlapMinutes * 60_000).toISOString());
  });

  it('never writes People Employer, only the three DTD columns', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.people.set('900', { id: '900', email: 'pat@example.org', firstName: 'Pat', lastName: 'Example', phone: null, dtdCompanyId: null });
    await runPull(h.deps, NOW);
    expect(h.personWrites).toEqual([{
      id: '900',
      values: {
        [P.dtdCompanyId]: 'c-7',
        [P.dtdCompany]: 'Example Corp',
        [P.dtdLink]: { url: 'https://example.org/match/abc', text: 'Start your match' },
      },
    }]);
    const allowed = new Set([P.dtdCompanyId, P.dtdCompany, P.dtdLink]);
    for (const w of h.personWrites) for (const k of Object.keys(w.values)) expect(allowed.has(k)).toBe(true);
  });

  it('skips the People write when the person already has that company id, and omits non-https links', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.people.set('900', { id: '900', email: null, firstName: 'Pat', lastName: 'Example', phone: null, dtdCompanyId: 'c-7' });
    await runPull(h.deps, NOW);
    expect(h.personWrites).toEqual([]);

    await env.DB.prepare('DELETE FROM dtd_records').run();
    const h2 = harness([dtd({ plugin_link: 'http://insecure.example.org/x' })]);
    h2.items.set('500', item());
    h2.people.set('900', { id: '900', email: null, firstName: 'Pat', lastName: 'Example', phone: null, dtdCompanyId: null });
    await runPull(h2.deps, NOW);
    expect(Object.keys(h2.personWrites[0]!.values).sort()).toEqual([P.dtdCompany, P.dtdCompanyId].sort());
  });

  it('keeps Matched over a DTD stage', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item({ matchStatus: 'Matched' }));
    const result = await runPull(h.deps, NOW);
    expect(h.donationWrites).toEqual([]);
    expect(result.written).toBe(0);
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: false });
  });

  it('carries an existing item id forward when a record cannot be resolved this run', async () => {
    await upsertRecord(env.DB, {
      donationIdentifier: 'fr-1', mondayItemId: '500', source: null, status: ':old', matchingGiftStatus: null,
      employerStatus: null, companyId: null, companyName: null, matchedAmount: null, donationDatetime: null,
      updatedSeenAt: '2026-10-01T00:00:00.000Z', unmatched: false,
    });
    const h = harness([dtd()]);
    await runPull(h.deps, NOW);
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: false, status: ':waiting-for-donor-action' });
  });

  it('propagates DtdAuthError and leaves the watermark alone', async () => {
    const h = harness([]);
    h.deps.dtd = { getUpdatedDonations: async () => { throw new DtdAuthError('bad key'); } };
    await expect(runPull(h.deps, NOW)).rejects.toBeInstanceOf(DtdAuthError);
    expect(await getWatermark(env.DB)).toBeNull();
  });
});
