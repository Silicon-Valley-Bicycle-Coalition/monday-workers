import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expectedTier, resolveColumns, columnValues, checkItem, rollupMoved, SCENARIOS, NEEDED_COLUMNS } from './donation-smoke.mjs';

const columns = NEEDED_COLUMNS.map((t, i) => ({ id: `c${i}`, title: t === 'Acknowledgment Tier' ? t : t }));
const { byTitle: cols } = resolveColumns(columns);

describe('expectedTier', () => {
  it('is Major at $200 and up and Standard below', () => {
    assert.equal(expectedTier(200), 'Major');
    assert.equal(expectedTier(250), 'Major');
    assert.equal(expectedTier(199.99), 'Standard');
    assert.equal(expectedTier(40), 'Standard');
  });
});

describe('resolveColumns', () => {
  it('matches titles ignoring read-only markers and reports missing ones', () => {
    const { byTitle, missing } = resolveColumns([{ id: 'a', title: 'Amount' }, { id: 'b', title: '🔒 Funding Stream' }, { id: 'c', title: '📜 Date' }]);
    assert.equal(byTitle.get('Date'), 'c');
    assert.ok(missing.includes('Donor'));
    assert.ok(!missing.includes('Amount'));
    assert.deepEqual(resolveColumns(columns).missing, []);
  });
});

describe('columnValues', () => {
  it('writes what the form writes, linking the donor only for a donor scenario', () => {
    const person = columnValues(cols, SCENARIOS[0], { donorItemId: '42', dateISO: '2026-11-11' });
    assert.equal(person[cols.get('Amount')], '250');
    assert.deepEqual(person[cols.get('Donor')], { item_ids: [42] });
    assert.deepEqual(person[cols.get('Status')], { label: 'Received' });
    assert.equal(cols.get('Anonymous Donor') in person, false);
    const anon = columnValues(cols, SCENARIOS[1], { donorItemId: '42', dateISO: '2026-11-11' });
    assert.equal(cols.get('Donor') in anon, false);
    assert.deepEqual(anon[cols.get('Anonymous Donor')], { checked: 'true' });
  });
});

describe('checkItem', () => {
  const item = (tier, status, donorIds) => ({
    text: new Map([[cols.get('Acknowledgment Tier'), tier], [cols.get('Status'), status]]), donorIds,
  });
  it('passes a correct gift', () => {
    assert.deepEqual(checkItem(cols, SCENARIOS[0], item('Major', 'Received', ['42'])), []);
    assert.deepEqual(checkItem(cols, SCENARIOS[1], item('Standard', 'Received', [])), []);
  });
  it('reports a wrong or blank tier, a wrong status, and donor link mistakes', () => {
    assert.equal(checkItem(cols, SCENARIOS[0], item('', 'Received', ['42'])).length, 1);
    assert.match(checkItem(cols, SCENARIOS[0], item('Standard', 'Received', ['42']))[0], /expected "Major"/);
    assert.match(checkItem(cols, SCENARIOS[0], item('Major', 'Pending', ['42']))[0], /Status/);
    assert.match(checkItem(cols, SCENARIOS[0], item('Major', 'Received', []))[0], /1 linked donor/);
    assert.match(checkItem(cols, SCENARIOS[1], item('Standard', 'Received', ['42']))[0], /no linked donor/);
  });
});

describe('rollupMoved', () => {
  it('is true only when Lifetime Giving rose by the gift amount', () => {
    assert.equal(rollupMoved(100, 350, 250), true);
    assert.equal(rollupMoved(100, 100, 250), false);
    assert.equal(rollupMoved(NaN, 350, 250), false);
  });
});
