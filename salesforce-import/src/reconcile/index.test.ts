import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReconcile, money } from './index.js';
import type { MondayReader, ReadItem } from './monday.js';
import { dataPath, readJson, writeJson, writeNdjson } from '../artifacts.js';
import { Ledger } from '../load/ledger.js';

// Frozen extract: two Opportunities in different fiscal years, one C&P transaction.
const OPPS = [
  { Id: 'o1', Amount: 100, CloseDate: '2024-07-15', StageName: 'Posted' },
  { Id: 'o2', Amount: 40.5, CloseDate: '2025-08-01', StageName: 'Posted' },
];
const CNP = [{ Id: 'tx1', CnP_PaaS__TotalCharged__c: 10, CnP_PaaS__TransactionDate__c: '2021-03-04T18:00:00.000+0000' }];
const PAYLOADS = [
  { board: 'people-live', sfId: 'c1', name: 'Ada', columns: { 'Lifetime Giving': '150.5', 'Gift Count': '3' } },
  { board: 'donations', sfId: 'o1', name: 'Gift 1', columns: {}, archive: true },
  { board: 'donations', sfId: 'o2', name: 'Gift 2', columns: {} },
  { board: 'donations', sfId: 'tx1', name: 'C&P', columns: {}, archive: true },
];
const BOARDS = { 'people-live': { boardId: 1, columns: {} }, donations: { boardId: 2, columns: {} } };

const debug = (sfId: string) => `SF ID: ${sfId} | Created: 2020-01-01`;
const gift = (id: string, sfId: string, amount: string, date: string, state = 'active'): ReadItem =>
  ({ id, state, boardId: '2', values: { 'Salesforce Debug': debug(sfId), Amount: amount, Date: date } });
const person = (id: string, sfId: string, lifetime: string, count: string): ReadItem =>
  ({ id, state: 'active', boardId: '1', values: { 'Salesforce Debug': debug(sfId), 'Lifetime Giving': lifetime, 'Gift Count': count } });

// What's on Monday when the load landed perfectly: o1 and tx1 archived, o2 active.
const perfect = (): ReadItem[] => [
  person('p1', 'c1', '150.5', '3'),
  gift('d1', 'o1', '100', '2024-07-15', 'archived'),
  gift('d2', 'o2', '40.5', '2025-08-01'),
  gift('d3', 'tx1', '10', '2021-03-04', 'archived'),
];

function fakeReader(items: ReadItem[], columns = ['Salesforce Debug', 'Amount', 'Date', 'Lifetime Giving', 'Gift Count']):
  MondayReader & { byIdCalls: string[][] } {
  const pick = (i: ReadItem, cols: Record<string, string>) =>
    ({ ...i, values: Object.fromEntries(Object.entries(i.values).filter(([t]) => t in cols)) });
  const byIdCalls: string[][] = [];
  return {
    byIdCalls,
    columns: async () => new Map(columns.map((t) => [t, `col_${t}`])),
    scan: async (boardId, cols) => items.filter((i) => i.boardId === String(boardId) && i.state === 'active')
      .map((i) => pick(i, cols)),
    byIds: async (ids, cols) => { byIdCalls.push([...ids]); return items.filter((i) => ids.includes(i.id)).map((i) => pick(i, cols)); },
  };
}

async function seed() {
  await writeNdjson(dataPath('extract', 'opportunities.ndjson'), OPPS);
  await writeNdjson(dataPath('extract', 'clickpledge_transactions.ndjson'), CNP);
  await writeJson(dataPath('extract', 'manifest.json'), { extractedAt: '2026-09-08T19:46:41.438Z' });
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), PAYLOADS);
  await writeJson(dataPath('load', 'boards.json'), BOARDS);
  await writeJson('config/svbc.json', { salesforceOrg: 'svbc', cutoverDateISO: '2026-10-01',
    peopleActiveSinceISO: '2019-01-01', activitySliceSinceISO: '2024-08-01', boardMaxItems: 9000,
    donationsActiveFiscalYears: 2, monday: { apiUrl: 'https://x', boardSuffix: '', boards: {} },
    localNews: { rules: [], defaultUrl: 'https://x/', defaultName: 'x' }, reconciliation: {} });
  const l = new Ledger(); await l.load();
  await l.recordSuccess({ sfId: 'c1', board: 'people-live', itemId: 'p1' });
  await l.recordSuccess({ sfId: 'o1', board: 'donations', itemId: 'd1' });
  await l.recordSuccess({ sfId: 'o2', board: 'donations', itemId: 'd2' });
  await l.recordSuccess({ sfId: 'tx1', board: 'donations', itemId: 'd3' });
}

const checks = async () => new Map((await readJson<{ checks: { name: string; ok: boolean; detail: string }[] }>(
  dataPath('reconcile', 'result.json'))).checks.map((c) => [c.name, c]));

describe('runReconcile', () => {
  beforeEach(async () => { process.chdir(mkdtempSync(join(tmpdir(), 'sfrecon-'))); await seed(); });

  it('is GO when Monday holds exactly the extract, archived gifts included', async () => {
    const reader = fakeReader(perfect());
    expect(await runReconcile([], { reader })).toBe(0);
    // Archived items are read back by id: only the ones the active scan couldn't see.
    expect(reader.byIdCalls).toEqual([['d1', 'd3']]);
    const report = readFileSync(dataPath('reconcile', 'report.md'), 'utf8');
    expect(report).toContain('# Post-load reconciliation — GO');
    expect(report).toContain('| FY2025 | 1 | 1 | 0 | $100.00 | $100.00 | 0 | OK |');
    expect(report).toContain('| **Total** | **3** | **3** | **0** | **$150.50** | **$150.50** | **0** | OK |');
    expect(report).toContain('| 1 | Ada | people-live | c1 | $150.50 | $150.50 | 0 | 3 / 3 | OK |');
  });

  it('is NO-GO when an archived gift was deleted from Monday', async () => {
    expect(await runReconcile([], { reader: fakeReader(perfect().filter((i) => i.id !== 'd3')) })).toBe(1);
    const c = await checks();
    expect(c.get('donations-by-fiscal-year')).toMatchObject({ ok: false, detail: expect.stringContaining('1 of 3 fiscal years differ (2021)') });
    expect(c.get('board-donations')).toMatchObject({ ok: false, detail: expect.stringContaining('1 missing (e.g. tx1)') });
  });

  it('ignores ledgered ids that Monday reports on another board or deleted', async () => {
    const items = perfect().map((i) => (i.id === 'd1' ? { ...i, boardId: '99' } : i.id === 'd3' ? { ...i, state: 'deleted' } : i));
    expect(await runReconcile([], { reader: fakeReader(items) })).toBe(1);
    expect((await checks()).get('board-donations')?.detail).toContain('2 missing');
  });

  it('is NO-GO on a duplicate create, and counts its Amount twice in the fiscal-year total', async () => {
    expect(await runReconcile([], { reader: fakeReader([...perfect(), gift('d9', 'o2', '40.5', '2025-08-01')]) })).toBe(1);
    const c = await checks();
    expect(c.get('board-donations')?.detail).toContain('1 duplicated (e.g. o2)');
    expect(readFileSync(dataPath('reconcile', 'report.md'), 'utf8'))
      .toContain('| FY2026 | 1 | 2 | +1 | $40.50 | $81.00 | +$40.50 | FAIL |');
  });

  it('pinpoints a gift whose Amount or Date changed on Monday', async () => {
    const items = perfect().map((i) => (i.id === 'd2' ? gift('d2', 'o2', '45', '2025-06-30') : i));
    expect(await runReconcile([], { reader: fakeReader(items) })).toBe(1);
    expect((await checks()).get('donations-by-salesforce-id')?.detail)
      .toBe('1 gifts with a different Amount (e.g. o2), 1 dated into a different fiscal year (e.g. o2) ' +
        '(missing/duplicated gifts are under board-donations)');
  });

  it('reports items without a Salesforce Id but leaves them out of the comparison', async () => {
    const stray: ReadItem = { id: 'd8', state: 'active', boardId: '2', values: { Amount: '500', Date: '2026-09-01' } };
    expect(await runReconcile([], { reader: fakeReader([...perfect(), stray]) })).toBe(0);
    expect((await checks()).get('board-donations')?.detail).toContain('1 without a Salesforce Id');
  });

  it('is NO-GO when a top donor\'s Lifetime Giving on Monday differs from the extract', async () => {
    const items = perfect().map((i) => (i.id === 'p1' ? person('p1', 'c1', '110.5', '2') : i));
    expect(await runReconcile(['--top', '5'], { reader: fakeReader(items) })).toBe(1);
    expect((await checks()).get('top-5-donors')).toMatchObject({ ok: false, detail: '1 of 1 differ (e.g. c1)' });
    expect(readFileSync(dataPath('reconcile', 'report.md'), 'utf8')).toContain('| $150.50 | $110.50 | -$40.00 | 3 / 2 | FAIL |');
  });

  it('is NO-GO when the transform did not come from this extract', async () => {
    await writeNdjson(dataPath('extract', 'opportunities.ndjson'), [...OPPS, { Id: 'o3', Amount: 5, CloseDate: '2026-09-01' }]);
    expect(await runReconcile([], { reader: fakeReader(perfect()) })).toBe(1);
    expect((await checks()).get('extract-matches-transform')?.detail).toContain('1 missing from transform (e.g. o3)');
  });

  it('falls back to a count-only check on a board with no Salesforce Id source', async () => {
    const items = perfect().map((i) => ({ ...i, values: { ...i.values, 'Salesforce Debug': '' } }));
    expect(await runReconcile(['--top', '0'], { reader: fakeReader(items, ['Amount', 'Date', 'Lifetime Giving']) })).toBe(1);
    const c = await checks();
    expect(c.get('board-people-live')).toMatchObject({ ok: true, detail: expect.stringContaining('count only') });
    expect(c.get('donations-by-fiscal-year')?.ok).toBe(false); // can't attribute gifts without an id
  });

  it('prefers the Salesforce ID column over Salesforce Debug', async () => {
    const items = perfect().map((i) => ({ ...i, values: { ...i.values, 'Salesforce ID': sfOf(i), 'Salesforce Debug': 'SF ID: wrong' } }));
    expect(await runReconcile([], { reader: fakeReader(items, ['Salesforce ID', 'Salesforce Debug', 'Amount', 'Date',
      'Lifetime Giving', 'Gift Count']) })).toBe(0);
  });

  it('fails a board missing from boards.json', async () => {
    await writeJson(dataPath('load', 'boards.json'), { donations: BOARDS.donations });
    expect(await runReconcile(['--top', '0'], { reader: fakeReader(perfect()) })).toBe(1);
    expect((await checks()).get('board-people-live')?.ok).toBe(false);
  });

  it('rejects a bad --top', async () => {
    expect(await runReconcile(['--top', 'x'], { reader: fakeReader(perfect()) })).toBe(2);
  });
});

const sfOf = (i: ReadItem) => /SF ID: (\S+)/.exec(i.values['Salesforce Debug'] ?? '')![1]!;

describe('money', () => {
  it('formats cents as dollars with sign and grouping', () => {
    expect(money(123456789)).toBe('$1,234,567.89');
    expect(money(-4000)).toBe('-$40.00');
    expect(money(0)).toBe('$0.00');
  });
});
