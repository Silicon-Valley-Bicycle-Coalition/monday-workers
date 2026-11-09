import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, planColumns, run, WANTED_COLUMNS } from './sponsor-outreach-setup.mjs';

const ORGS = '100';
const AFFS = '200';
const SPONS = '300';

// A fake Monday: boards hold columns and items; mutations are recorded, never applied.
export function fakeMonday(boards) {
  const mutations = [];
  const gql = async (query, vars = {}) => {
    if (query.trimStart().startsWith('mutation')) {
      mutations.push({ query, vars });
      return { create_column: { id: 'new' }, change_multiple_column_values: { id: vars.item } };
    }
    if (query.includes('next_items_page')) throw new Error('fake has one page');
    const board = boards[vars.ids?.[0]];
    if (!board) return { boards: [] };
    if (query.includes('items_page')) {
      const cols = new Set(vars.cols ?? []);
      return {
        boards: [{
          items_page: {
            cursor: null,
            items: (board.items ?? []).map((it) => ({
              id: it.id,
              name: it.name,
              column_values: [...cols].map((id) => ({
                id,
                text: it.values?.[id]?.text ?? null,
                value: it.values?.[id]?.value ?? null,
                linked_item_ids: it.values?.[id]?.linked ?? [],
              })),
            })),
          },
        }],
      };
    }
    return { boards: [{ id: vars.ids[0], columns: board.columns }] };
  };
  return { gql, mutations };
}

const sink = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
};

describe('parseArgs', () => {
  it('parses columns', () =>
    assert.deepEqual(
      parseArgs(['columns', '--organizations', ORGS, '--affiliations', AFFS, '--sponsorships', SPONS, '--apply']),
      { command: 'columns', organizations: ORGS, affiliations: AFFS, sponsorships: SPONS, apply: true },
    ));
  it('requires its boards', () => assert.throws(() => parseArgs(['columns', '--organizations', ORGS])));
  it('rejects a non-numeric board', () =>
    assert.throws(() => parseArgs(['columns', '--organizations', 'x', '--affiliations', AFFS, '--sponsorships', SPONS])));
  it('rejects an unknown command', () => assert.throws(() => parseArgs(['nope'])));
});

describe('planColumns', () => {
  const all = new Map([
    ['Sponsor Prospect', { id: 'a', type: 'checkbox' }],
    ['Prospect Notes', { id: 'b', type: 'text' }],
  ]);
  const orgWanted = WANTED_COLUMNS.organizations;
  it('wants nothing when all are present', () => assert.deepEqual(planColumns(all, orgWanted), { create: [], wrongType: [] }));
  it('creates the missing', () =>
    assert.deepEqual(planColumns(new Map(), orgWanted).create.map((c) => c.title), ['Sponsor Prospect', 'Prospect Notes']));
  it('flags a wrong type', () =>
    assert.deepEqual(
      planColumns(new Map([['Sponsor Prospect', { id: 'a', type: 'text' }], ['Prospect Notes', { id: 'b', type: 'text' }]]), orgWanted).wrongType,
      ['Sponsor Prospect'],
    ));
});

describe('columns', () => {
  const args = { command: 'columns', organizations: ORGS, affiliations: AFFS, sponsorships: SPONS, apply: false };
  const boards = () => ({
    [ORGS]: { columns: [{ id: 'x', title: 'Name', type: 'name' }] },
    [AFFS]: { columns: [{ id: 'y', title: '🔒 Sponsor Contact', type: 'checkbox' }] },
    [SPONS]: { columns: [] },
  });
  it('a dry run sends no mutation', async () => {
    const m = fakeMonday(boards());
    const s = sink();
    assert.equal(await run(args, { gql: m.gql, ...s }), 0);
    assert.equal(m.mutations.length, 0);
  });
  it('--apply creates exactly the missing columns, the link aimed at Organizations', async () => {
    const m = fakeMonday(boards());
    assert.equal(await run({ ...args, apply: true }, { gql: m.gql, ...sink() }), 0);
    const made = m.mutations.map((x) => `${x.vars.board}:${x.vars.title}:${x.vars.type}`);
    assert.deepEqual(made, [
      `${ORGS}:Sponsor Prospect:checkbox`,
      `${ORGS}:Prospect Notes:text`,
      `${SPONS}:Organization:board_relation`,
    ]);
    const link = m.mutations.find((x) => x.vars.title === 'Organization');
    assert.deepEqual(JSON.parse(link.vars.defaults), { boardIds: [Number(ORGS)] });
  });
  it('a wrong type exits 1 and creates nothing', async () => {
    const b = boards();
    b[SPONS].columns.push({ id: 'z', title: 'Organization', type: 'text' });
    const m = fakeMonday(b);
    assert.equal(await run({ ...args, apply: true }, { gql: m.gql, ...sink() }), 1);
    assert.equal(m.mutations.length, 0);
  });
});
