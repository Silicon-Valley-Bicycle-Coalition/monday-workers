import { describe, it, expect } from 'vitest';
import { runClassify, CLASSIFY_WRITES_PER_RUN, type ClassifyClient } from './classify';
import type { DonationRollupsConfig } from '../types';
import { MondayRateLimitError } from '../monday/client';

const CL = { fundingStream: 'fs', giftSize: 'gs', fiscalQuarter: 'fq', giftFiscalYear: 'gfy' };
const config = {
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  donationRollups: { donationBoards: [
    { boardId: 100, columns: { amount: 'am', date: 'dt', giftType: 'gt', classification: CL } },
    { boardId: 200, columns: { amount: 'am', date: 'dt', giftType: null, classification: null } },
  ] },
} as unknown as DonationRollupsConfig;

type Row = Record<string, string | null>;
function fakeClient(rows: Row[], pageSize = 2) {
  const writes: { boardId: number; itemId: string; values: Record<string, unknown>; opts?: unknown }[] = [];
  const reads: number[] = [];
  const client: ClassifyClient = {
    async pageItemsColumnsText(boardId, columnIds, cursor) {
      reads.push(boardId);
      const start = cursor === null ? 0 : Number(cursor);
      const slice = rows.slice(start, start + pageSize);
      return {
        items: slice.map((r) => ({ id: r.id!, text: new Map(columnIds.map((c) => [c, r[c] ?? null])) })),
        cursor: start + pageSize < rows.length ? String(start + pageSize) : null,
      };
    },
    async changeColumnValues(boardId, itemId, values, opts) { writes.push({ boardId, itemId, values, opts }); },
  };
  return { client, writes, reads };
}

describe('runClassify', () => {
  it('writes all four labels for an unclassified gift, creating missing labels', async () => {
    const { client, writes } = fakeClient([{ id: '1', am: '250', dt: '2025-10-01', gt: 'Membership' }]);
    const report = await runClassify(client, config);
    expect(writes).toEqual([{ boardId: 100, itemId: '1', opts: { createLabelsIfMissing: true },
      values: { fs: { label: 'Membership' }, gs: { label: '$250–999' }, fq: { label: 'FY26 Q2' }, gfy: { label: 'FY2026' } } }]);
    expect(report).toMatchObject({ ok: true, detail: { scanned: 1, changed: 1, written: 1, remaining: 0 } });
  });

  it('skips a gift whose labels already match, and writes only the columns that differ', async () => {
    const { client, writes } = fakeClient([
      { id: '1', am: '50', dt: '2025-08-01', gt: 'Donation', fs: 'Individual Giving', gs: '< $100', fq: 'FY26 Q1', gfy: 'FY2026' },
      { id: '2', am: '50', dt: '2025-08-01', gt: 'Donation', fs: 'Individual Giving', gs: '$5k+', fq: 'FY26 Q1', gfy: 'FY2026' },
    ]);
    await runClassify(client, config);
    expect(writes).toEqual([{ boardId: 100, itemId: '2', opts: { createLabelsIfMissing: true }, values: { gs: { label: '< $100' } } }]);
  });

  it('clears a label that should now be blank (amount removed)', async () => {
    const { client, writes } = fakeClient([{ id: '1', am: null, dt: '2025-08-01', gt: 'Donation', fs: 'Individual Giving', gs: '< $100', fq: 'FY26 Q1', gfy: 'FY2026' }]);
    await runClassify(client, config);
    expect(writes[0]!.values).toEqual({ gs: '' });
  });

  it('pages through the whole board and ignores boards with classification off', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), am: '10', dt: '2025-08-01', gt: 'Donation' }));
    const { client, writes, reads } = fakeClient(rows, 2);
    await runClassify(client, config);
    expect(reads).toEqual([100, 100, 100]);
    expect(writes).toHaveLength(5);
  });

  it('caps writes per run and reports the remainder', async () => {
    const rows = Array.from({ length: CLASSIFY_WRITES_PER_RUN + 7 }, (_, i) => ({ id: String(i), am: '10', dt: '2025-08-01', gt: 'Donation' }));
    const { client, writes } = fakeClient(rows, 500);
    const report = await runClassify(client, config);
    expect(writes).toHaveLength(CLASSIFY_WRITES_PER_RUN);
    expect(report.detail).toMatchObject({ changed: CLASSIFY_WRITES_PER_RUN + 7, written: CLASSIFY_WRITES_PER_RUN, remaining: 7 });
    expect(report.summary).toMatch(/run classify again/);
  });

  it('reads amounts with thousands separators', async () => {
    const { client, writes } = fakeClient([{ id: '1', am: '5,000', dt: '2025-08-01', gt: 'Donation' }]);
    await runClassify(client, config);
    expect(writes[0]!.values['gs']).toEqual({ label: '$5k+' });
  });

  it('isolates a failing item: later items are still written and the report is not ok', async () => {
    const rows = ['1', '2', '3'].map((id) => ({ id, am: '10', dt: '2025-08-01', gt: 'Donation' }));
    const { client, writes } = fakeClient(rows, 500);
    const inner = client.changeColumnValues;
    client.changeColumnValues = async (b, id, v, o) => { if (id === '2') throw new Error('item gone'); return inner(b, id, v, o); };
    const report = await runClassify(client, config);
    expect(writes.map((w) => w.itemId)).toEqual(['1', '3']);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/1 item write\(s\) failed/);
    expect(report.detail).toMatchObject({ written: 2, failed: 1, failedItemIds: ['2'], remaining: 0 });
  });

  it('caps the failed-id list in the report', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: String(i), am: '10', dt: '2025-08-01', gt: 'Donation' }));
    const { client } = fakeClient(rows, 500);
    client.changeColumnValues = async () => { throw new Error('nope'); };
    const report = await runClassify(client, config);
    const d = report.detail as { failed: number; failedItemIds: string[] };
    expect(d.failed).toBe(30);
    expect(d.failedItemIds).toHaveLength(20);
  });

  it('rethrows a rate limit so the run stops', async () => {
    const rows = ['1', '2', '3'].map((id) => ({ id, am: '10', dt: '2025-08-01', gt: 'Donation' }));
    const { client, writes } = fakeClient(rows, 500);
    const inner = client.changeColumnValues;
    client.changeColumnValues = async (b, id, v, o) => { if (id === '2') throw new MondayRateLimitError('slow down', 30); return inner(b, id, v, o); };
    await expect(runClassify(client, config)).rejects.toBeInstanceOf(MondayRateLimitError);
    expect(writes.map((w) => w.itemId)).toEqual(['1']);
  });
});
