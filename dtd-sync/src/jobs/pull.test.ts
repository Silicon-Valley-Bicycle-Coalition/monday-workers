import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runPull, type PullDeps } from './pull';
import { validateConfig } from '../config';
import { DtdAuthError } from '../dtd/client';
import type { DtdDonation } from '../dtd/types';
import type { DonationItem, DtdMondayClient, PersonItem } from '../monday/client';
import { getRecord, upsertRecord } from '../db/records';
import { recordPush } from '../db/pushes';
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
function person(over: Partial<PersonItem> = {}): PersonItem {
  return { id: '900', email: 'pat@example.org', householdEmail: null, firstName: 'Pat', lastName: 'Example', phone: null, dtdCompanyId: null, ...over };
}
function dtd(over: Partial<DtdDonation> = {}): DtdDonation {
  return {
    donation_identifier: 'fr-1', source: null, donation_datetime: '2026-10-01T08:00:00-07:00',
    donor_email: 'pat@example.org', donation_amount: null, company_name: 'Example Corp', doublethedonation_company_id: 'c-7',
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
  h.people.set('900', person());
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
  await env.DB.prepare('DELETE FROM pushes').run();
  await env.DB.prepare('DELETE FROM sync_state').run();
});
afterEach(() => vi.restoreAllMocks());

function unmatchedRow(identifier: string, seenAt: string) {
  return {
    donationIdentifier: identifier, mondayItemId: null, source: null, status: ':pending', matchingGiftStatus: null,
    employerStatus: null, companyId: null, companyName: null, matchedAmount: null, donationDatetime: null,
    updatedSeenAt: seenAt, unmatched: true, donorEmailHash: null, donationAmount: null,
  };
}

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
    await recordPush(env.DB, '501', 'monday-501', NOW.toISOString());
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

  it('stores a record whose Monday write throws as retryable, advances the watermark, and retries it next run', async () => {
    await setWatermark(env.DB, '2026-11-01T00:00:00.000Z');
    const h = harness([dtd(), dtd({ donation_identifier: 'fr-2' })]);
    h.items.set('500', item());
    h.items.set('501', item({ id: '501', funraiseId: 'fr-2' }));
    h.state.failDonationWrite = true;
    await runPull(h.deps, NOW);
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: true, status: ':waiting-for-donor-action' });
    expect(await getRecord(env.DB, 'fr-2')).toMatchObject({ mondayItemId: '501', unmatched: true });
    // The next run (Monday back up, DTD reporting nothing new) retries both from D1.
    h.state.failDonationWrite = false;
    h.state.donations = [];
    await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(h.donationWrites.map((w) => w.id).sort()).toEqual(['500', '501']);
    expect(h.donationWrites[0]!.values[D.dtdStatusRaw]).toBe(':waiting-for-donor-action');
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ unmatched: false });
    expect(await getRecord(env.DB, 'fr-2')).toMatchObject({ unmatched: false });
  });

  it('logs a failed record by identifier with the error message scrubbed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.deps.monday.updateDonation = async () => { throw new Error('column rejected value pat@example.org'); };
    await runPull(h.deps, NOW);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('dtd-sync: pull item fr-1 failed column rejected value [email]');
    expect(lines.join('\n')).not.toContain('pat@example.org');
  });

  it('holds the watermark only when a failed record could not be stored either', async () => {
    await setWatermark(env.DB, '2026-11-01T00:00:00.000Z');
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.state.failDonationWrite = true;
    const db = h.deps.db;
    h.deps.db = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'prepare') return Reflect.get(target, prop);
        return (sql: string) => {
          if (sql.includes('INSERT INTO dtd_records')) throw new Error('d1 down');
          return target.prepare(sql);
        };
      },
    });
    await runPull(h.deps, NOW);
    expect(await getWatermark(db)).toBe('2026-11-01T00:00:00.000Z');
  });

  it('retries 50 unmatched rows a run and rotates, so the 51st is tried next run', async () => {
    for (let i = 0; i <= 50; i++) await upsertRecord(env.DB, unmatchedRow(`fr-${String(i).padStart(2, '0')}`, '2026-10-01T00:00:00.000Z'));
    const h = harness([]);
    await runPull(h.deps, NOW);
    expect(h.lookups).toHaveLength(50);
    expect(h.lookups).not.toContain('fr:fr-50');
    expect(await getRecord(env.DB, 'fr-00')).toMatchObject({ updatedSeenAt: NOW.toISOString(), unmatched: true });
    h.lookups.length = 0;
    await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(h.lookups[0]).toBe('fr:fr-50');
  });

  it('writes nothing for a donor that is not on People (an Organizations donor): ownership is unprovable', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness([dtd()]);
    h.items.set('500', item({ donorItemId: '777' })); // getPeople drops off-board ids, so 777 comes back empty
    const result = await runPull(h.deps, NOW);
    expect(result).toEqual({ fetched: 1, written: 0, unmatched: 1 });
    expect(h.donationWrites).toEqual([]);
    expect(h.personWrites).toEqual([]);
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());
  });

  it('treats a monday- identifier whose item is on another board as unresolved', async () => {
    // getDonation returns null for an item that isn't on the Donations board.
    const h = harness([dtd({ donation_identifier: 'monday-888', source: 'monday' })]);
    const result = await runPull(h.deps, NOW);
    expect(result).toEqual({ fetched: 1, written: 0, unmatched: 1 });
    expect(await getRecord(env.DB, 'monday-888')).toMatchObject({ mondayItemId: null, unmatched: true });
  });

  it('uses the watermark minus the overlap, or the previous fiscal year start on the first run', async () => {
    const h = harness([]);
    await runPull(h.deps, NOW);
    expect(h.fetched[0]).toEqual({ since: '2025-07-01T00:00:00.000Z', to: NOW.toISOString() });
    await env.DB.prepare('DELETE FROM sync_state').run();
    await runPull(h.deps, new Date('2026-06-30T23:00:00Z')); // still FY2026 → FY2025 started 2024-07-01
    expect(h.fetched[1]!.since).toBe('2024-07-01T00:00:00.000Z');
    await env.DB.prepare('DELETE FROM sync_state').run();
    await setWatermark(env.DB, '2026-11-02T00:00:00.000Z');
    await runPull(h.deps, NOW);
    expect(h.fetched[2]!.since).toBe(new Date(Date.parse('2026-11-02T00:00:00.000Z') - config.dtd.pullOverlapMinutes * 60_000).toISOString());
  });

  it('never writes People Employer, only the three DTD columns', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.people.set('900', person());
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
    h.people.set('900', person({ dtdCompanyId: 'c-7' }));
    await runPull(h.deps, NOW);
    expect(h.personWrites).toEqual([]);

    await env.DB.prepare('DELETE FROM dtd_records').run();
    const h2 = harness([dtd({ plugin_link: 'http://insecure.example.org/x' })]);
    h2.items.set('500', item());
    h2.people.set('900', person());
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
      updatedSeenAt: '2026-10-01T00:00:00.000Z', unmatched: false, donorEmailHash: null, donationAmount: null,
    });
    const h = harness([dtd()]);
    await runPull(h.deps, NOW);
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: true, status: ':waiting-for-donor-action' });
  });

  it('writes the stored status once a carried-forward record resolves on retry', async () => {
    await upsertRecord(env.DB, {
      donationIdentifier: 'fr-1', mondayItemId: '500', source: null, status: ':old', matchingGiftStatus: null,
      employerStatus: null, companyId: null, companyName: null, matchedAmount: null, donationDatetime: null,
      updatedSeenAt: '2026-10-01T00:00:00.000Z', unmatched: false, donorEmailHash: null, donationAmount: null,
    });
    const h = harness([dtd()]);
    await runPull(h.deps, NOW);
    expect(h.donationWrites).toEqual([]);
    h.state.donations = [];
    h.items.set('500', item());
    await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(h.donationWrites).toHaveLength(1);
    expect(h.donationWrites[0]!.values[D.dtdStatusRaw]).toBe(':waiting-for-donor-action');
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ unmatched: false });
  });

  it('keeps a record retryable when updatePerson throws after updateDonation, then finishes it next run', async () => {
    const h = harness([dtd()]);
    h.items.set('500', item());
    h.people.set('900', person());
    const updatePerson = h.deps.monday.updatePerson;
    h.deps.monday.updatePerson = async () => { throw new Error('monday down'); };
    await runPull(h.deps, NOW);
    expect(h.donationWrites).toHaveLength(1);
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ mondayItemId: '500', unmatched: true, companyId: 'c-7' });
    expect(await getWatermark(env.DB)).toBe(NOW.toISOString());

    h.deps.monday.updatePerson = updatePerson;
    h.state.donations = [];
    await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
    expect(h.personWrites.map((w) => w.id)).toEqual(['900']);
    expect(await getRecord(env.DB, 'fr-1')).toMatchObject({ unmatched: false });
  });

  it('propagates DtdAuthError and leaves the watermark alone', async () => {
    const h = harness([]);
    h.deps.dtd = { getUpdatedDonations: async () => { throw new DtdAuthError('bad key'); } };
    await expect(runPull(h.deps, NOW)).rejects.toBeInstanceOf(DtdAuthError);
    expect(await getWatermark(env.DB)).toBeNull();
  });

  describe('ownership check (DTD plugin key is public, so a record can be forged)', () => {
    const noWrites = (h: Harness) => { expect(h.donationWrites).toEqual([]); expect(h.personWrites).toEqual([]); };

    it('ignores a monday- identifier this Worker never pushed', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donation_identifier: 'monday-501', source: 'monday' })]);
      h.items.set('501', item({ id: '501', funraiseId: null }));
      expect(await runPull(h.deps, NOW)).toEqual({ fetched: 1, written: 0, unmatched: 1 });
      noWrites(h);
      expect(await getRecord(env.DB, 'monday-501')).toMatchObject({ mondayItemId: null, unmatched: true });
    });

    it('ignores a monday- identifier whose push is only recorded as failed', async () => {
      await env.DB.prepare("INSERT INTO pushes (monday_item_id, dtd_identifier, state) VALUES ('501', 'monday-501', 'failed')").run();
      const h = harness([dtd({ donation_identifier: 'monday-501', source: 'monday' })]);
      h.items.set('501', item({ id: '501', funraiseId: null }));
      await runPull(h.deps, NOW);
      noWrites(h);
    });

    it('does not write when the donor email differs, and logs the item id without the email', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donor_email: 'attacker@evil.example' })]);
      h.items.set('500', item());
      expect(await runPull(h.deps, NOW)).toEqual({ fetched: 1, written: 0, unmatched: 1 });
      noWrites(h);
      expect(log).toHaveBeenCalledWith('dtd-sync: pull item 500 skipped: donor mismatch');
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/@/);
      const rec = await getRecord(env.DB, 'fr-1');
      expect(rec).toMatchObject({ mondayItemId: null, unmatched: true });
      expect(JSON.stringify(rec)).not.toContain('evil.example');
    });

    it('does not write when the DTD record has no email', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donor_email: null })]);
      h.items.set('500', item());
      await runPull(h.deps, NOW);
      noWrites(h);
    });

    it('does not write when the item has no donor on People', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd()]);
      h.items.set('500', item({ donorItemId: null }));
      await runPull(h.deps, NOW);
      noWrites(h);
      h.items.set('500', item({ donorItemId: '777' }));
      await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
      noWrites(h);
    });

    it('matches the email case-insensitively and trimmed, and accepts the household email', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donor_email: '  PAT@Example.ORG ' })]);
      h.items.set('500', item());
      await runPull(h.deps, NOW);
      expect(h.donationWrites.map((w) => w.id)).toEqual(['500']);

      const h2 = harness([dtd({ donation_identifier: 'fr-2', donor_email: 'home@example.org' })]);
      h2.items.set('500', item({ funraiseId: 'fr-2' }));
      h2.people.set('900', person({ householdEmail: 'Home@Example.org' }));
      await runPull(h2.deps, NOW);
      expect(h2.donationWrites.map((w) => w.id)).toEqual(['500']);
    });

    it('does not write when the amounts differ by more than 1%, and writes within 1%', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donation_amount: 60 })]);
      h.items.set('500', item({ amount: 50 }));
      await runPull(h.deps, NOW);
      noWrites(h);

      const ok = harness([dtd({ donation_amount: 50.4 })]);
      ok.items.set('500', item({ amount: 50 }));
      await runPull(ok.deps, NOW);
      expect(ok.donationWrites).toHaveLength(1);
    });

    it('skips the amount check when DTD sends no amount or the item has none', async () => {
      const h = harness([dtd({ donation_amount: null })]);
      h.items.set('500', item({ amount: 50 }));
      await runPull(h.deps, NOW);
      expect(h.donationWrites).toHaveLength(1);
    });

    it('never writes a mismatched record on retry, nor stores the raw email', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donor_email: 'attacker@evil.example' })]);
      h.items.set('500', item());
      await runPull(h.deps, NOW);
      h.state.donations = [];
      await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
      await runPull(h.deps, new Date('2026-11-03T14:00:00Z'));
      noWrites(h);
      const row = await env.DB.prepare('SELECT * FROM dtd_records WHERE donation_identifier = ?').bind('fr-1').first();
      expect(JSON.stringify(row)).not.toContain('evil.example');
      expect(row).toMatchObject({ unmatched: 1, monday_item_id: null });
    });

    it('never writes an amount-mismatched record on retry', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donation_amount: 5000 })]);
      h.items.set('500', item({ amount: 50 }));
      await runPull(h.deps, NOW);
      h.state.donations = [];
      await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
      noWrites(h);
    });

    it('still writes on retry when a failed record belongs to the item', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const h = harness([dtd({ donation_amount: 50 })]);
      h.items.set('500', item({ amount: 50 }));
      h.state.failDonationWrite = true;
      await runPull(h.deps, NOW);
      h.state.failDonationWrite = false;
      h.state.donations = [];
      await runPull(h.deps, new Date('2026-11-03T13:00:00Z'));
      expect(h.donationWrites.map((w) => w.id)).toEqual(['500']);
    });
  });
});
