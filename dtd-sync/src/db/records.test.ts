import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  companyForItem, getRecord, hasDtdRecordForItem, listUnmatched, recordsForFiscalYear, upsertRecord,
  type StoredRecord,
} from './records';

beforeEach(async () => { await env.DB.prepare('DELETE FROM dtd_records').run(); });

function rec(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    donationIdentifier: 'd-1', mondayItemId: 'm-1', source: 'funraise', status: 'matched',
    matchingGiftStatus: 'paid', employerStatus: 'eligible', companyId: 'c-1', companyName: 'Example Org',
    matchedAmount: 25.5, donationDatetime: '2026-03-01T10:00:00Z', updatedSeenAt: '2026-03-02T00:00:00Z',
    unmatched: false, donorEmailHash: 'abc123', donationAmount: 25, ...over,
  };
}

describe('records', () => {
  it('round-trips a record, including nulls and the unmatched flag', async () => {
    await upsertRecord(env.DB, rec());
    expect(await getRecord(env.DB, 'd-1')).toEqual(rec());
    const sparse = rec({ donationIdentifier: 'd-2', mondayItemId: null, source: null, status: null, matchingGiftStatus: null,
      employerStatus: null, companyId: null, companyName: null, matchedAmount: null, donationDatetime: null, unmatched: true, donorEmailHash: null, donationAmount: null });
    await upsertRecord(env.DB, sparse);
    expect(await getRecord(env.DB, 'd-2')).toEqual(sparse);
    expect(await getRecord(env.DB, 'nope')).toBeNull();
  });
  it('upsert replaces the existing row', async () => {
    await upsertRecord(env.DB, rec());
    await upsertRecord(env.DB, rec({ status: 'paid', matchedAmount: 40 }));
    expect(await getRecord(env.DB, 'd-1')).toEqual(rec({ status: 'paid', matchedAmount: 40 }));
  });
  it('listUnmatched returns only unmatched rows, oldest seen first, up to the limit', async () => {
    await upsertRecord(env.DB, rec({ donationIdentifier: 'a', unmatched: true, updatedSeenAt: '2026-03-03T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'b', unmatched: true, updatedSeenAt: '2026-03-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'c', unmatched: false }));
    expect((await listUnmatched(env.DB, 10, '2000-01-01T00:00:00Z')).map((r) => r.donationIdentifier)).toEqual(['b', 'a']);
    expect((await listUnmatched(env.DB, 1, '2000-01-01T00:00:00Z')).map((r) => r.donationIdentifier)).toEqual(['b']);
  });
  it('recordsForFiscalYear is half-open on donation_datetime', async () => {
    await upsertRecord(env.DB, rec({ donationIdentifier: 'before', donationDatetime: '2025-06-30T23:59:59Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'start', donationDatetime: '2025-07-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'mid', donationDatetime: '2026-01-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'end', donationDatetime: '2026-07-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'none', donationDatetime: null }));
    const rows = await recordsForFiscalYear(env.DB, '2025-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(rows.map((r) => r.donationIdentifier).sort()).toEqual(['mid', 'start']);
  });
  it('recordsForFiscalYear counts only verified rows (matched, with an item link)', async () => {
    await upsertRecord(env.DB, rec({ donationIdentifier: 'ok' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'forged', mondayItemId: null, unmatched: true }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'retry', unmatched: true }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'nolink', mondayItemId: null }));
    const rows = await recordsForFiscalYear(env.DB, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
    expect(rows.map((r) => r.donationIdentifier)).toEqual(['ok']);
  });
  it('hasDtdRecordForItem checks monday_item_id', async () => {
    await upsertRecord(env.DB, rec());
    expect(await hasDtdRecordForItem(env.DB, 'm-1')).toBe(true);
    expect(await hasDtdRecordForItem(env.DB, 'm-2')).toBe(false);
  });
  it('companyForItem ignores unverified rows', async () => {
    await upsertRecord(env.DB, rec({ donationIdentifier: 'ok', companyName: 'Real Co', updatedSeenAt: '2026-01-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'bad', companyName: 'Forged Co', unmatched: true, updatedSeenAt: '2026-02-01T00:00:00Z' }));
    expect(await companyForItem(env.DB, 'm-1')).toBe('Real Co');
  });
  it('companyForItem returns the most recently seen company, or null', async () => {
    await upsertRecord(env.DB, rec({ donationIdentifier: 'old', companyName: 'Old Co', updatedSeenAt: '2026-01-01T00:00:00Z' }));
    await upsertRecord(env.DB, rec({ donationIdentifier: 'new', companyName: 'New Co', updatedSeenAt: '2026-02-01T00:00:00Z' }));
    expect(await companyForItem(env.DB, 'm-1')).toBe('New Co');
    expect(await companyForItem(env.DB, 'm-9')).toBeNull();
    await upsertRecord(env.DB, rec({ donationIdentifier: 'nc', mondayItemId: 'm-3', companyName: null }));
    expect(await companyForItem(env.DB, 'm-3')).toBeNull();
  });
});
