import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acsValue, parseAcsRows, summaryFileTable } from './acs.mjs';

test('suppressed income becomes null', () => assert.equal(acsValue('-666666666'), null));
test('other negative sentinels become null', () => assert.equal(acsValue('-222222222'), null));
test('numbers parse', () => assert.equal(acsValue('62000'), 62000));
test('non-numeric becomes null', () => {
  assert.equal(acsValue(''), null);
  assert.equal(acsValue(null), null);
  assert.equal(acsValue('N'), null);
});
test('rows key by full block-group GEOID', () => {
  const m = parseAcsRows([['B01003_001E','B19013_001E','state','county','tract','block group'],
                          ['4200','-666666666','06','085','500100','1']]);
  assert.deepEqual(m.get('060855001001'), { population: 4200, medianIncome: null });
});
test('rows find columns by header name, not position', () => {
  const m = parseAcsRows([['state','county','tract','block group','B19013_001E','B01003_001E'],
                          ['06','081','600100','2','91000','1500']]);
  assert.deepEqual(m.get('060816001002'), { population: 1500, medianIncome: 91000 });
});
test('suppressed population counts as 0, not null', () => {
  const m = parseAcsRows([['B01003_001E','B19013_001E','state','county','tract','block group'],
                          ['-666666666','50000','06','085','500100','1']]);
  assert.equal(m.get('060855001001').population, 0);
});

// The ACS table-based summary file: pipe-delimited, one file per table, every geography level.
const POP = [
  'GEO_ID|B01003_E001|B01003_M001',
  '0100000US|334922499|-555555555',
  '1400000US06085500100|8285|1500',
  '1500000US060855001001|1809|1024',
  '1500000US060855001003|2006|880',
  '1500000US060816001003|300|100',
  '1500000US060010001001|999|100',
].join('\n');
const INCOME = [
  'GEO_ID|B19013_E001|B19013_M001',
  '1500000US060855001001|131857|55511',
  '1500000US060855001003|-666666666|-222222222',
  '1500000US060816001003|70000|9000',
].join('\n');

test('summary files become an API-shaped table of the wanted counties\' block groups', () => {
  const table = summaryFileTable(POP, INCOME, '06', ['081', '085']);
  assert.deepEqual(table[0], ['B01003_001E', 'B19013_001E', 'state', 'county', 'tract', 'block group']);
  assert.deepEqual(table.slice(1).sort(), [
    ['1809', '131857', '06', '085', '500100', '1'],
    ['2006', '-666666666', '06', '085', '500100', '3'],
    ['300', '70000', '06', '081', '600100', '3'],
  ].sort());
});
test('summary file table round-trips through parseAcsRows', () => {
  const m = parseAcsRows(summaryFileTable(POP, INCOME, '06', ['081', '085']));
  assert.equal(m.size, 3);
  assert.deepEqual(m.get('060855001003'), { population: 2006, medianIncome: null });
  assert.equal(m.has('060010001001'), false);
});
test('a block group missing from the income file gets a null income', () => {
  const m = parseAcsRows(summaryFileTable(POP + '\n1500000US060855001009|12|5', INCOME, '06', ['085']));
  assert.deepEqual(m.get('060855001009'), { population: 12, medianIncome: null });
});
