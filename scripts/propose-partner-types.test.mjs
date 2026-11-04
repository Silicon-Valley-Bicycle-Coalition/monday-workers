import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewRows, toCsv, HEADER, summarize } from './propose-partner-types.mjs';

const item = (id, name, partnerType, extra = {}) => ({
  id,
  name,
  url: `https://example.monday.com/pulses/${id}`,
  column_values: {
    text_mm8nbhwa: partnerType,
    link_mm8nwkyg: null,
    text_mm8nsrw9: null,
    text_mm8njjg8: null,
    text_mm8n8w1z: null,
    numeric_mm8naf1t: null,
    date_mm8pp5pp: null,
    ...extra,
  },
});

const col = (row, title) => row[HEADER.indexOf(title)];

test('rows needing the most judgment sort first', () => {
  const rows = reviewRows([
    item('1', 'Acme', 'Corporation'),
    item('2', 'Zephyr', null),
    item('3', 'City of Fremont', null),
  ]);
  assert.deepEqual(rows.map((r) => col(r, 'Item ID')), ['2', '3', '1']);
});

test('within a confidence level, the largest lifetime giving comes first', () => {
  const rows = reviewRows([
    item('1', 'Small', 'Corporation', { numeric_mm8naf1t: '50' }),
    item('2', 'Large', 'Corporation', { numeric_mm8naf1t: '5000' }),
    item('3', 'None', 'Corporation'),
  ]);
  assert.deepEqual(rows.map((r) => col(r, 'Item ID')), ['2', '1', '3']);
});

test('the website column feeds the proposal', () => {
  const [row] = reviewRows([item('1', 'Traffic Office', null, { link_mm8nwkyg: 'https://x.ca.gov/a' })]);
  assert.equal(col(row, 'Proposed Type'), 'Municipal');
  assert.equal(col(row, 'Website'), 'https://x.ca.gov/a');
});

test('the reviewer column starts empty', () => {
  const [row] = reviewRows([item('1', 'Acme', 'Corporation')]);
  assert.equal(col(row, 'Reviewed Type'), '');
});

test('a name that starts like a formula is neutralized', () => {
  const csv = toCsv([['=HYPERLINK("http://evil")', 'plain']]);
  assert.equal(csv, `"'=HYPERLINK(""http://evil"")",plain\n`);
});

test('the summary counts proposals, confidence, and unmapped values', () => {
  const rows = reviewRows([
    item('1', 'Acme', 'Corporation'),
    item('2', 'Zephyr', null),
    item('3', 'Thing', 'Moon Base'),
  ]);
  const summary = summarize(rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.byConfidence.high, 1);
  assert.equal(summary.byConfidence.none, 2);
  assert.equal(summary.byType.Corporation, 1);
  assert.equal(summary.unmapped, 1);
});
