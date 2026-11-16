import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, toSql } from './bootstrap-matches.mjs';

const boards = { organizations: { boardId: 400 }, 'people-live': { boardId: 301 }, 'people-historical': { boardId: 302 }, donations: { boardId: 200 } };
const ledger = [
  { kind: 'success', sfId: 'ORG1', board: 'organizations', itemId: '40001' },
  { kind: 'success', sfId: 'P1', board: 'people-live', itemId: '30001' },
  { kind: 'success', sfId: 'P2', board: 'people-historical', itemId: '30002' },
  { kind: 'success', sfId: 'G1', board: 'donations', itemId: '20001' },
  { kind: 'success', sfId: 'G2', board: 'donations', itemId: '20002' },
  { kind: 'success', sfId: 'G3', board: 'donations', itemId: '20003' },
  { kind: 'success', sfId: 'G4', board: 'donations', itemId: '20004' },
  { kind: 'success', sfId: 'G5', board: 'donations', itemId: '20005' },
  { kind: 'success', sfId: 'G6', board: 'donations', itemId: '20006' },
  { kind: 'success', sfId: 'G8', board: 'donations', itemId: '20008' },
  { kind: 'success', sfId: 'G1', board: 'donations', itemId: '29999' }, // a later success wins
];
const gift = (sfId, { type = 'Matching Donation', donor = 'P1', matchedBy = 'ORG1', date = '2019-04-12', amount = '500' } = {}) => ({
  board: 'donations', sfId, name: 'Acme - Employer Matching Pat 2019',
  columns: { 'Gift Type': type, Date: date === null ? null : { date }, Amount: amount },
  links: [...(donor ? [{ column: 'Donor', targetSfIds: [donor] }] : []), ...(matchedBy ? [{ column: 'Matched By', targetSfIds: [matchedBy] }] : [])],
});
const payloads = [
  gift('G1'),
  gift('G2', { donor: 'P2', amount: '' }),
  gift('G3', { type: 'Donation' }),
  gift('G4', { donor: 'ORG1' }),
  gift('G5', { donor: null }),
  gift('G6', { matchedBy: null }),
  gift('G7'), // never landed: not in the ledger
  gift('G8', { date: null }),
  { board: 'people-live', sfId: 'P1', name: 'Pat', columns: {}, links: [] },
];

test('maps a Matching Donation to Monday item ids, date and cents, with the later ledger success winning', () => {
  const { rows } = buildRows({ payloads, ledger, boards });
  assert.deepEqual(rows[0], { donationItemId: '29999', personItemId: '30001', orgItemId: '40001', matchDate: '2019-04-12', amountCents: 50000 });
});

test('accepts a People (Historical) donor and a blank amount', () => {
  const { rows } = buildRows({ payloads, ledger, boards });
  assert.deepEqual(rows[1], { donationItemId: '20002', personItemId: '30002', orgItemId: '40001', matchDate: '2019-04-12', amountCents: null });
  assert.equal(rows.length, 2);
});

test('skips and counts everything that is not a storable match', () => {
  const { counts } = buildRows({ payloads, ledger, boards });
  assert.deepEqual(counts, { matching: 7, stored: 2, orgDonor: 1, noDonor: 1, noMatchedBy: 1, notLoaded: 1, noDate: 1 });
});

test('emits INSERT OR IGNORE in batches of 500 with source bootstrap, and no names', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ donationItemId: String(i + 1), personItemId: '30001', orgItemId: '40001', matchDate: '2019-04-12', amountCents: null }));
  const sql = toSql(many, '2026-11-16T00:00:00Z');
  assert.equal((sql.match(/INSERT OR IGNORE INTO matches/g) ?? []).length, 2);
  assert.match(sql, /'bootstrap'/);
  assert.match(sql, /\('1', '30001', '40001', '2019-04-12', NULL, 'bootstrap', '2026-11-16T00:00:00Z'\)/);
  const named = toSql(buildRows({ payloads, ledger, boards }).rows, '2026-11-16T00:00:00Z');
  assert.doesNotMatch(named, /Pat|Acme/);
});

test('refuses a non-numeric id in SQL output', () => {
  assert.throws(() => toSql([{ donationItemId: "1'; DROP", personItemId: '1', orgItemId: '1', matchDate: '2019-01-01', amountCents: null }], '2026-11-16T00:00:00Z'), /numeric/);
});
