import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchStatusLabels, labelIds, donationColumnSpecs, PEOPLE_COLUMN_SPECS, programSummarySpecs,
  planColumns, createColumnDefaults, labelIndex, viewFilter, parseArgs, RESERVED_LABEL_ID,
  typeConflicts, ensurePeopleColumns, OUTREACH_DONATION_SPECS, OUTREACH_PROGRAM_SPECS, outreachPeopleIds,
} from './setup-columns.mjs';

const STATUS_LABELS = {
  ':identification-in-progress': 'Identifying employer',
  ':waiting-for-donor-action': 'Waiting for donor',
  ':ineligible': 'Not eligible',
  ':closed-program-eligibility': 'Not eligible',
};

test('match status labels are distinct values plus Matched, Other and Prompted', () => {
  assert.deepEqual(matchStatusLabels(STATUS_LABELS), ['Identifying employer', 'Waiting for donor', 'Not eligible', 'Matched', 'Other', 'Prompted']);
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

const ARGS = ['--donations', '1', '--people', '2', '--people-historical', '4', '--workspace', '3'];

test('parseArgs requires numeric ids and a value per flag', () => {
  assert.deepEqual(parseArgs(ARGS), { donations: '1', people: '2', 'people-historical': '4', workspace: '3' });
  assert.throws(() => parseArgs(['--donations', '1', '--people', '2', '--people-historical', '4']), /workspace/);
  assert.throws(() => parseArgs(['--donations', '--people', '2', '--people-historical', '4', '--workspace', '3']), /needs a value/);
});

test('parseArgs requires --people-historical', () => {
  assert.throws(() => parseArgs(['--donations', '1', '--people', '2', '--workspace', '3']), /--people-historical/);
});

test('parseArgs refuses the same board as People and People (Historical)', () => {
  assert.throws(() => parseArgs(['--donations', '1', '--people', '2', '--people-historical', '2', '--workspace', '3']), /different boards/);
});

test('planColumns finds People columns on Historical by bare title', () => {
  const { have, missing } = planColumns(PEOPLE_COLUMN_SPECS, [
    { id: 'text_h', title: '🔒 DTD Company ID', type: 'text' }, { id: 'link_h', title: 'DTD match link', type: 'link' },
  ]);
  assert.deepEqual(have, { dtdCompanyId: 'text_h', dtdLink: 'link_h' });
  assert.deepEqual(missing.map((s) => s.key), ['dtdCompany']);
});

test('typeConflicts names a same-title column of another type, ignoring markers', () => {
  assert.deepEqual(typeConflicts(PEOPLE_COLUMN_SPECS, [
    { id: 'a', title: '🔒 DTD match link', type: 'text' },
    { id: 'b', title: '📜 DTD Company', type: 'text' },
    { id: 'c', title: 'Unrelated', type: 'link' },
  ]), [{ title: 'DTD match link', expected: 'link', actual: 'text' }]);
});

// Boards keyed by id, with an ensureColumns that records what it was asked to provision.
function fakeMonday(boards) {
  const ensured = [];
  return {
    ensured,
    readBoard: async (id) => boards[id],
    ensureColumns: async (board, specs) => {
      ensured.push({ board: board.id, specs });
      return Object.fromEntries(specs.map((s) => [s.key, `${board.id}:${s.key}`]));
    },
  };
}

const PEOPLE_ARGS = { people: '2', 'people-historical': '4' };

test('ensurePeopleColumns provisions identical specs on both boards', async () => {
  const monday = fakeMonday({ 2: { id: '2', name: 'People', columns: [] }, 4: { id: '4', name: 'People (Historical)', columns: [] } });
  await ensurePeopleColumns(PEOPLE_ARGS, monday);
  assert.deepEqual(monday.ensured.map((e) => e.board).sort(), ['2', '4']);
  assert.deepEqual(monday.ensured[0].specs, PEOPLE_COLUMN_SPECS);
  assert.deepEqual(monday.ensured[1].specs, PEOPLE_COLUMN_SPECS);
});

test('ensurePeopleColumns returns only the People ids, the ones config needs', async () => {
  const monday = fakeMonday({ 2: { id: '2', name: 'People', columns: [] }, 4: { id: '4', name: 'People (Historical)', columns: [] } });
  assert.deepEqual(await ensurePeopleColumns(PEOPLE_ARGS, monday), { dtdCompanyId: '2:dtdCompanyId', dtdCompany: '2:dtdCompany', dtdLink: '2:dtdLink' });
});

for (const [label, peopleColumns, historicalColumns, named] of [
  ['Historical', [], [{ id: 'x', title: 'DTD Company', type: 'long_text' }], 'People (Historical)'],
  ['People', [{ id: 'x', title: 'DTD match link', type: 'text' }], [], 'People'],
]) {
  test(`ensurePeopleColumns creates nothing when ${label} has a wrong-typed column`, async () => {
    const monday = fakeMonday({ 2: { id: '2', name: 'People', columns: peopleColumns }, 4: { id: '4', name: 'People (Historical)', columns: historicalColumns } });
    await assert.rejects(ensurePeopleColumns(PEOPLE_ARGS, monday), new RegExp(`${named.replace(/[()]/g, '\\$&')}: "DTD`));
    assert.deepEqual(monday.ensured, []);
  });
}

test('the post-gift email columns are opt-in, keyed as outreach config expects', () => {
  assert.deepEqual(OUTREACH_DONATION_SPECS.map((s) => [s.key, s.title, s.type]), [['matchPromptSent', 'Match Prompt Sent', 'date']]);
  assert.deepEqual(OUTREACH_PROGRAM_SPECS.map((s) => [s.key, s.title, s.type]), [
    ['prompted', 'Prompted', 'numbers'], ['promptedMatched', 'Prompted and matched', 'numbers'], ['promptedMatchDollars', 'Prompted match dollars', 'numbers'],
  ]);
  const base = ['--donations', '1', '--people', '2', '--people-historical', '3', '--workspace', '4'];
  assert.equal(parseArgs(base).outreach, undefined);
  assert.equal(parseArgs([...base, '--outreach', 'yes']).outreach, 'yes');
  assert.throws(() => parseArgs([...base, '--outreach', 'no']), /--outreach/);
});

test('outreachPeopleIds finds the existing People columns, marked or not, and names a missing one', () => {
  const columns = [{ id: 'text_1', title: 'Employer Name' }, { id: 'boolean_1', title: '🔒 Do Not Solicit' }];
  assert.deepEqual(outreachPeopleIds(columns), { employerName: 'text_1', doNotSolicit: 'boolean_1' });
  assert.throws(() => outreachPeopleIds(columns.slice(0, 1)), /Do Not Solicit/);
});
