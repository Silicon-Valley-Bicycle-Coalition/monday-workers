import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { runPush, noonLosAngeles, type PushDeps } from './push';
import { validateConfig } from '../config';
import { DtdApiError, DtdAuthError } from '../dtd/client';
import type { DtdRegistration } from '../dtd/types';
import type { DonationItem, DtdMondayClient, PersonItem } from '../monday/client';
import { getPush, recordPush } from '../db/pushes';
import { upsertRecord } from '../db/records';
import sandbox from '../../config/sandbox.json';

const base = validateConfig(sandbox);
const NOW = new Date('2026-11-03T12:00:00Z');

function item(over: Partial<DonationItem> = {}): DonationItem {
  return {
    id: '500', amount: 50, date: '2026-10-30', status: 'Received', giftType: 'Donation', funraiseId: null,
    salesforceId: null, benevityTransactionId: null, anonymous: false, donorItemId: '900', matchedByItemId: null,
    matchesGiftItemId: null, matchPairing: null, matchStatus: null, sentToDtd: null, updatedAt: '', ...over,
  };
}
function person(over: Partial<PersonItem> = {}): PersonItem {
  return { id: '900', email: 'staff@example.org', householdEmail: null, firstName: 'Sam', lastName: 'Okafor', phone: null, dtdCompanyId: null, ...over };
}

interface Harness {
  deps: PullDepsLike;
  sent: DtdRegistration[];
  writes: { id: string; values: Record<string, unknown> }[];
  listed: string[];
  peopleCalls: string[][];
  items: DonationItem[];
  people: Map<string, PersonItem>;
  fail: { dtd: Error | null; mondayWrite: boolean };
}
type PullDepsLike = PushDeps;

function harness(allowEmails: string[] | '*' | null = ['staff@example.org']): Harness {
  const config = { ...base, push: { ...base.push, allowEmails } };
  const h: Harness = {
    sent: [], writes: [], listed: [], peopleCalls: [], items: [], people: new Map([['900', person()]]),
    fail: { dtd: null, mondayWrite: false }, deps: undefined as unknown as PushDeps,
  };
  const monday: Partial<DtdMondayClient> = {
    listDonationsDatedSince: async (d) => { h.listed.push(d); return h.items; },
    getPeople: async (ids) => { h.peopleCalls.push(ids); return ids.flatMap((i) => h.people.get(i) ?? []); },
    updateDonation: async (id, values) => {
      if (h.fail.mondayWrite) throw new Error('monday down');
      h.writes.push({ id, values });
    },
  };
  h.deps = {
    dtd: { registerDonation: async (b) => { if (h.fail.dtd) throw h.fail.dtd; h.sent.push(b); } },
    monday: monday as DtdMondayClient, db: env.DB, config,
  };
  return h;
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pushes').run();
  await env.DB.prepare('DELETE FROM dtd_records').run();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('noonLosAngeles', () => {
  it('uses -07:00 in PDT', () => expect(noonLosAngeles('2026-10-15')).toBe('2026-10-15T12:00:00-07:00'));
  it('uses -08:00 in PST', () => expect(noonLosAngeles('2026-12-15')).toBe('2026-12-15T12:00:00-08:00'));
});

describe('runPush', () => {
  it('fetches People only for gifts that pass every item-level check', async () => {
    const h = harness();
    h.items = [
      item({ id: '1', donorItemId: '900' }),
      item({ id: '2', donorItemId: '901', status: 'Pending' }),
      item({ id: '3', donorItemId: '902', anonymous: true }),
    ];
    await runPush(h.deps, NOW);
    expect(h.peopleCalls).toEqual([['900']]);
  });

  it('registers an eligible gift and marks Sent to DTD', async () => {
    const h = harness();
    h.items = [item({ amount: 75.5, date: '2026-10-15' })];
    h.people.set('900', person({ phone: '555-0100' }));
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 1, sent: 1, failed: 0 });
    expect(h.sent).toEqual([{
      campaign: base.dtd.campaign, donation_identifier: 'monday-500', donation_amount: 75.5,
      donation_datetime: '2026-10-15T12:00:00-07:00', donor_first_name: 'Sam', donor_last_name: 'Okafor',
      donor_email: 'staff@example.org', donor_phone: '555-0100',
    }]);
    expect(h.writes).toEqual([{ id: '500', values: { [base.donations.sentToDtd]: { date: '2026-11-03' } } }]);
    expect((await getPush(env.DB, '500'))?.state).toBe('sent');
  });

  it('omits donor_phone when absent and batches one getPeople call', async () => {
    const h = harness();
    h.items = [item({ id: '500' }), item({ id: '501' })];
    await runPush(h.deps, NOW);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.some((s) => 'donor_phone' in s)).toBe(false);
    expect(h.peopleCalls).toEqual([['900']]);
  });

  it('lists from the earlier of the rolling window and backfillFromISO', async () => {
    const h = harness();
    h.deps.config = { ...h.deps.config, push: { ...h.deps.config.push, backfillFromISO: '2026-10-23' } };
    await runPush(h.deps, NOW);
    expect(h.listed).toEqual(['2026-10-04']);
    h.deps.config = { ...h.deps.config, push: { ...h.deps.config.push, windowDays: 3 } };
    await runPush(h.deps, NOW);
    expect(h.listed[1]).toBe('2026-10-23');
  });

  it('sandbox sends only allow-listed emails', async () => {
    const h = harness(['staff@example.org']);
    h.items = [item({ id: '500', donorItemId: '900' }), item({ id: '501', donorItemId: '901' })];
    h.people.set('901', person({ id: '901', email: 'donor@example.org' }));
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 2, sent: 1, failed: 0 });
    expect(h.sent.map((s) => s.donation_identifier)).toEqual(['monday-500']);
  });

  it('allowEmails null sends nothing', async () => {
    const h = harness(null);
    h.items = [item()];
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 1, sent: 0, failed: 0 });
    expect(h.sent).toEqual([]);
  });

  it('skips items DTD already knows', async () => {
    const h = harness();
    h.items = [item()];
    await upsertRecord(env.DB, {
      donationIdentifier: 'fr-9', mondayItemId: '500', source: null, status: null, matchingGiftStatus: null,
      employerStatus: null, companyId: null, companyName: null, matchedAmount: null, donationDatetime: null,
      updatedSeenAt: NOW.toISOString(), unmatched: false, donorEmailHash: null, donationAmount: null,
    });
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 1, sent: 0, failed: 0 });
    expect(h.sent).toEqual([]);
  });

  it('a failed push is retried, a recorded push is not', async () => {
    const h = harness();
    h.items = [item({ id: '500' }), item({ id: '501' })];
    await recordPush(env.DB, '501', 'monday-501', NOW.toISOString());
    h.fail.dtd = new DtdApiError('boom for a@example.org', 503);
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 2, sent: 0, failed: 1 });
    const failed = await getPush(env.DB, '500');
    expect(failed?.state).toBe('failed');
    expect(failed?.lastError).not.toContain('@');
    expect(h.writes).toEqual([]);

    h.fail.dtd = null;
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 2, sent: 1, failed: 0 });
    expect(h.sent.map((s) => s.donation_identifier)).toEqual(['monday-500']);
    expect((await getPush(env.DB, '500'))?.state).toBe('sent');
  });

  it('auth error stops the run', async () => {
    const h = harness();
    h.items = [item({ id: '500' }), item({ id: '501' })];
    h.fail.dtd = new DtdAuthError('bad key');
    await expect(runPush(h.deps, NOW)).rejects.toBeInstanceOf(DtdAuthError);
    expect(await getPush(env.DB, '500')).toBeNull();
    expect(await getPush(env.DB, '501')).toBeNull();
  });

  it('a Monday write failure after a send is logged and does not resend next run', async () => {
    const h = harness();
    h.items = [item()];
    h.fail.mondayWrite = true;
    expect(await runPush(h.deps, NOW)).toEqual({ considered: 1, sent: 1, failed: 0 });
    expect((await getPush(env.DB, '500'))?.state).toBe('sent');
    h.fail.mondayWrite = false;
    await runPush(h.deps, NOW);
    expect(h.sent).toHaveLength(1);
  });

  it('logs counts only, never an email or name', async () => {
    const h = harness();
    h.items = [item()];
    await runPush(h.deps, NOW);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('example.org');
    expect(logged).not.toContain('Okafor');
  });
});
