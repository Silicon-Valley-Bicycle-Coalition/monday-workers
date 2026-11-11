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
// A status cell's stored value: Monday stores the label's index, and null when the cell is empty.
const SET = '{"index":1}';
// `values` overrides a cell's stored value; by default a cell with text is a set label.
function fakeClient(rows: Row[], pageSize = 2, values: Record<string, Row> = {}) {
  const writes: { boardId: number; itemId: string; values: Record<string, unknown>; opts?: unknown }[] = [];
  const reads: number[] = [];
  const client: ClassifyClient = {
    async pageItemsColumnsText(boardId, columnIds, cursor) {
      reads.push(boardId);
      const start = cursor === null ? 0 : Number(cursor);
      const slice = rows.slice(start, start + pageSize);
      return {
        items: slice.map((r) => ({ id: r.id!, text: new Map(columnIds.map((c) => [c, r[c] ?? null])),
          values: new Map(columnIds.map((c) => [c, c in (values[r.id!] ?? {}) ? values[r.id!]![c]! : r[c] ? SET : null])) })),
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
      values: { fs: { label: 'Membership' }, gs: { label: '$200–999' }, fq: { label: 'FY26 Q2' }, gfy: { label: 'FY2026' } } }]);
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

  it('writes a blank status cell whose text reads as the label at id 5', async () => {
    // Monday returns label id 5's text for an EMPTY status cell. With "Membership" at id 5 on
    // Funding Stream, a blank gift's text already says "Membership" — only the value shows it's empty.
    const { client, writes } = fakeClient(
      [{ id: '1', am: '250', dt: '2025-10-01', gt: 'Membership', fs: 'Membership', gs: '$200–999', fq: 'FY26 Q2', gfy: 'FY2026' }],
      2, { '1': { fs: null } });
    await runClassify(client, config);
    expect(writes).toEqual([{ boardId: 100, itemId: '1', opts: { createLabelsIfMissing: true }, values: { fs: { label: 'Membership' } } }]);
  });

  it('treats a stored value without a numeric index as blank', async () => {
    const { client, writes } = fakeClient(
      [{ id: '1', am: '250', dt: '2025-10-01', gt: 'Membership', fs: 'Membership', gs: '$200–999', fq: 'FY26 Q2', gfy: 'FY2026' }],
      2, { '1': { fs: '{}', gs: '' } });
    await runClassify(client, config);
    expect(writes[0]!.values).toEqual({ fs: { label: 'Membership' }, gs: { label: '$200–999' } });
  });

  it("doesn't clear a blank cell whose text reads as a label", async () => {
    // No amount or date: Gift Size, Fiscal Quarter and Gift Fiscal Year should stay blank, and
    // already are — only Funding Stream (from the blank Gift Type) is written.
    const { client, writes } = fakeClient([{ id: '1', am: null, dt: null, gt: null, fs: 'Other', gs: 'Other', fq: 'Other', gfy: 'Other' }],
      2, { '1': { fs: null, gs: null, fq: null, gfy: null } });
    await runClassify(client, config);
    expect(writes[0]!.values).toEqual({ fs: { label: 'Individual Giving' } });
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

  describe('Acknowledgment Tier', () => {
    const tierConfig = { ...config, donationRollups: { donationBoards: [
      { boardId: 100, columns: { amount: 'am', date: 'dt', giftType: 'gt', classification: { ...CL, acknowledgmentTier: 'at' } } },
    ] } } as unknown as DonationRollupsConfig;
    const labelled = { dt: '2025-08-01', gt: 'Donation', fs: 'Individual Giving', fq: 'FY26 Q1', gfy: 'FY2026' };

    it('sets Major at $200 and Standard below, alongside the other labels', async () => {
      const { client, writes } = fakeClient([
        { id: '1', am: '200', ...labelled, gs: '$200–999' },
        { id: '2', am: '199.99', ...labelled, gs: '$100–199' },
      ]);
      await runClassify(client, tierConfig);
      expect(writes.map((w) => [w.itemId, w.values])).toEqual([
        ['1', { at: { label: 'Major' } }],
        ['2', { at: { label: 'Standard' } }],
      ]);
    });

    it('fixes a wrong tier and skips a right one', async () => {
      const { client, writes } = fakeClient([
        { id: '1', am: '250', ...labelled, gs: '$200–999', at: 'Standard' },
        { id: '2', am: '250', ...labelled, gs: '$200–999', at: 'Major' },
      ]);
      await runClassify(client, tierConfig);
      expect(writes.map((w) => [w.itemId, w.values])).toEqual([['1', { at: { label: 'Major' } }]]);
    });

    it('leaves the tier alone on a gift with no amount', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: null, ...labelled, at: 'Major' }]);
      await runClassify(client, tierConfig);
      expect(writes).toEqual([]);
    });

    it('reads the tier only when it is configured', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '250', ...labelled, gs: '$200–999' }]);
      const report = await runClassify(client, config);
      expect(writes).toEqual([]);
      expect(report.detail).toMatchObject({ changed: 0 });
    });
  });

  describe('Matching Company', () => {
    // The company behind a matching gift, copied from the Matched By relation's linked item name
    // into a status column so charts can group by it (a relation can't be a chart axis).
    const mcConfig = { ...config, donationRollups: { donationBoards: [
      { boardId: 100, columns: { amount: 'am', date: 'dt', giftType: 'gt', matchedBy: 'mb', classification: { ...CL, matchingCompany: 'mc' } } },
    ] } } as unknown as DonationRollupsConfig;
    const labelled = { dt: '2025-08-01', gt: 'Matching Donation', fs: 'Matching Donations', gs: '$100–199', fq: 'FY26 Q1', gfy: 'FY2026' };

    it('copies the linked company name, creating the label on first use', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '150', ...labelled, mb: 'Google, LLC' }]);
      await runClassify(client, mcConfig);
      expect(writes).toEqual([{ boardId: 100, itemId: '1', opts: { createLabelsIfMissing: true },
        values: { mc: { label: 'Google, LLC' } } }]);
    });

    it('skips a gift already labelled with the right company', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '150', ...labelled, mb: 'Apple', mc: 'Apple' }]);
      await runClassify(client, mcConfig);
      expect(writes).toEqual([]);
    });

    it('fixes a stale company', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '150', ...labelled, mb: 'Apple', mc: 'Google, LLC' }]);
      await runClassify(client, mcConfig);
      expect(writes.map((w) => w.values)).toEqual([{ mc: { label: 'Apple' } }]);
    });

    it('clears the label when the gift has no Matched By link', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '150', ...labelled, mb: null, mc: 'Apple' }]);
      await runClassify(client, mcConfig);
      expect(writes.map((w) => w.values)).toEqual([{ mc: '' }]);
    });

    it('leaves an ordinary gift with no company alone', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '150', ...labelled, gt: 'Donation', fs: 'Individual Giving', mb: null }]);
      await runClassify(client, mcConfig);
      expect(writes).toEqual([]);
    });

    it('does nothing about companies unless both columns are configured', async () => {
      const { client, writes, reads } = fakeClient([{ id: '1', am: '150', ...labelled, mb: 'Apple' }]);
      await runClassify(client, config);
      expect(writes).toEqual([]);
      expect(reads.length).toBeGreaterThan(0);
    });
  });

  describe('Fiscal Year Ending', () => {
    const fyConfig = { ...config, donationRollups: { donationBoards: [
      { boardId: 100, columns: { amount: 'am', date: 'dt', giftType: 'gt', fiscalYear: 'fy', classification: CL } },
    ] } } as unknown as DonationRollupsConfig;
    const labelled = { gt: 'Donation', fs: 'Individual Giving', gs: '< $100', fq: 'FY26 Q1', gfy: 'FY2026' };

    it('stamps a blank Fiscal Year Ending from the date, by the July rule', async () => {
      const { client, writes } = fakeClient([
        { id: '1', am: '50', dt: '2025-08-01', ...labelled },
        { id: '2', am: '50', dt: '2026-06-30', ...labelled, fq: 'FY26 Q4' },
        { id: '3', am: '50', dt: '2026-07-01', ...labelled, fq: 'FY27 Q1', gfy: 'FY2027' },
      ]);
      await runClassify(client, fyConfig);
      expect(writes.map((w) => [w.itemId, w.values])).toEqual([
        ['1', { fy: '2026' }], ['2', { fy: '2026' }], ['3', { fy: '2027' }],
      ]);
    });

    it('treats a whitespace-only cell as blank', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '50', dt: '2025-08-01', ...labelled, fy: '  ' }]);
      await runClassify(client, fyConfig);
      expect(writes[0]!.values).toEqual({ fy: '2026' });
    });

    it('never overwrites a stamped value, even one that disagrees with the date', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '50', dt: '2025-08-01', ...labelled, fy: '2024' }]);
      await runClassify(client, fyConfig);
      expect(writes).toEqual([]);
    });

    it('leaves it blank on a gift with no usable date', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '50', dt: null, ...labelled, fq: null, gfy: null }],
        2, { '1': { fq: null, gfy: null } });
      await runClassify(client, fyConfig);
      expect(writes.every((w) => !('fy' in w.values))).toBe(true);
    });

    it('does nothing when the board has no Fiscal Year Ending column', async () => {
      const { client, writes } = fakeClient([{ id: '1', am: '50', dt: '2025-08-01', ...labelled }]);
      await runClassify(client, config);
      expect(writes).toEqual([]);
    });
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
