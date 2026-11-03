import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchStatusLabels, labelIds, donationColumnSpecs, PEOPLE_COLUMN_SPECS, programSummarySpecs,
  planColumns, createColumnDefaults, labelIndex, viewFilter, parseArgs, RESERVED_LABEL_ID,
} from './setup-columns.mjs';

const STATUS_LABELS = {
  ':identification-in-progress': 'Identifying employer',
  ':waiting-for-donor-action': 'Waiting for donor',
  ':ineligible': 'Not eligible',
  ':closed-program-eligibility': 'Not eligible',
};

test('match status labels are distinct values plus Matched and Other', () => {
  assert.deepEqual(matchStatusLabels(STATUS_LABELS), ['Identifying employer', 'Waiting for donor', 'Not eligible', 'Matched', 'Other']);
});

test('label ids never put a real label on the reserved empty-cell id', () => {
  const labels = Array.from({ length: 9 }, (_, i) => `L${i}`);
  const ids = labelIds(labels);
  assert.equal(ids[RESERVED_LABEL_ID], undefined);
  assert.deepEqual(Object.values(ids), labels);
  assert.deepEqual(Object.keys(ids).map(Number), [0, 1, 2, 3, 4, 6, 7, 8, 9]);
});

test('specs cover every config key with the right titles and descriptions', () => {
  const d = donationColumnSpecs(STATUS_LABELS);
  assert.deepEqual(d.map((s) => s.key), ['matchStatus', 'dtdStatusRaw', 'matchCompany', 'matchesGift', 'matchPairing', 'sentToDtd']);
  assert.ok(d.every((s) => s.description));
  assert.equal(d.find((s) => s.key === 'matchPairing').description, 'Set Staff to lock a link you made by hand');
  assert.deepEqual(d.find((s) => s.key === 'matchPairing').labels, ['Auto', 'Needs review', 'Staff']);
  assert.deepEqual(PEOPLE_COLUMN_SPECS.map((s) => s.type), ['text', 'text', 'link']);
});

test('program summary specs follow the config keys and reject unknown ones', () => {
  const specs = programSummarySpecs(['fiscalYear', 'screened', 'matchDollars', 'asOf']);
  assert.deepEqual(specs.map((s) => [s.title, s.type]), [['Fiscal Year', 'text'], ['Screened', 'numbers'], ['Match dollars', 'numbers'], ['As of', 'date']]);
  assert.throws(() => programSummarySpecs(['bogus']), /bogus/);
});

test('planColumns matches by bare title, ignoring lock markers', () => {
  const specs = donationColumnSpecs(STATUS_LABELS);
  const { have, missing } = planColumns(specs, [
    { id: 'color_1', title: '🔒 Match Status' }, { id: 'text_1', title: 'Match Company' }, { id: 'x', title: 'Unrelated' },
  ]);
  assert.deepEqual(have, { matchStatus: 'color_1', matchCompany: 'text_1' });
  assert.deepEqual(missing.map((s) => s.key), ['dtdStatusRaw', 'matchesGift', 'matchPairing', 'sentToDtd']);
});

test('createColumnDefaults: status labels, self-relation, passthrough', () => {
  const [status, , , relation] = donationColumnSpecs(STATUS_LABELS);
  assert.equal(JSON.parse(createColumnDefaults(status, '77')).labels[0], 'Identifying employer');
  assert.deepEqual(JSON.parse(createColumnDefaults(relation, '77')), { boardIds: [77] });
  assert.equal(createColumnDefaults({ type: 'text' }, '77'), undefined);
});

test('labelIndex reads the index Monday assigned', () => {
  const s = JSON.stringify({ labels: { 0: 'A', 6: 'Waiting for donor' } });
  assert.equal(labelIndex(s, 'Waiting for donor'), 6);
  assert.equal(labelIndex(s, 'Nope'), undefined);
});

test('viewFilter is a single any_of rule on the label index', () => {
  assert.deepEqual(viewFilter('color_x', 1), { operator: 'and', rules: [{ column_id: 'color_x', compare_value: [1], operator: 'any_of' }] });
});

test('parseArgs requires numeric ids and a value per flag', () => {
  assert.deepEqual(parseArgs(['--donations', '1', '--people', '2', '--workspace', '3']), { donations: '1', people: '2', workspace: '3' });
  assert.throws(() => parseArgs(['--donations', '1', '--people', '2']), /workspace/);
  assert.throws(() => parseArgs(['--donations', '--people', '2', '--workspace', '3']), /needs a value/);
});
