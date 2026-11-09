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
    if (query.includes('items(ids')) {
      const want = new Set((vars.ids ?? []).map(String));
      const cols = vars.cols ?? [];
      const found = Object.values(boards).flatMap((b) => b.items ?? []).filter((it) => want.has(String(it.id)));
      return {
        items: found.map((it) => ({
          id: it.id,
          name: it.name,
          column_values: cols.map((id) => ({ id, text: it.values?.[id]?.text ?? null, value: null, linked_item_ids: [] })),
        })),
      };
    }
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

import { cycleReport } from './sponsor-outreach-setup.mjs';

describe('cycleReport', () => {
  const types = ['Sponsorship', 'In Kind Donation / Sponsorship'];
  const rows = [
    { cycle: '2014 Dinner', giftType: 'Sponsorship' },
    { cycle: '2015 dinner', giftType: 'In Kind Donation / Sponsorship' },
    { cycle: '2011 Bike Ride', giftType: 'Sponsorship' },
    { cycle: '2020 Gala', giftType: 'Membership' },
    { cycle: null, giftType: 'Sponsorship' },
  ];
  const r = cycleReport(rows, { Dinner: 'Annual Gala' }, types);
  it('groups one event across years and case', () =>
    assert.deepEqual(r.byEvent.find((e) => e.event === 'Dinner'), { event: 'Dinner', label: 'Annual Gala', years: [2014, 2015], count: 2 }));
  it('leaves an unmapped event with a null label', () =>
    assert.equal(r.byEvent.find((e) => e.event === 'Bike Ride').label, null));
  it('ignores other gift types', () => assert.equal(r.byEvent.some((e) => e.event === 'Gala'), false));
  it('counts rows without a year', () => assert.equal(r.noYear, 1));
});

describe('cycles command', () => {
  const DON = '400';
  const ledger = (rows) => ({ text: JSON.stringify(rows) });
  const boards = {
    [ORGS]: {
      columns: [{ id: 'gl', title: '🔒 Gift Ledger (JSON)', type: 'text' }],
      items: [
        { id: 'o1', name: 'Org', values: { gl: ledger([['1', '2014-05-01', 500000, 'Sponsorship', 'Received', ''], ['9', '2014-01-01', 100, 'Membership', 'Received', '']]) } },
        { id: 'o2', name: 'Org2', values: { gl: ledger([['2', '2012-05-01', 100000, 'Sponsorship', 'Failed', '']]) } },
        { id: 'o3', name: 'No gifts', values: { gl: { text: null } } },
      ],
    },
    [DON]: {
      columns: [{ id: 'gt', title: 'Gift Type', type: 'text' }, { id: 'cy', title: 'Sponsorship Cycle', type: 'text' }],
      items: [
        { id: '1', name: 'g1', values: { gt: { text: 'Sponsorship' }, cy: { text: '2014 Dinner' } } },
        { id: '2', name: 'g2', values: { gt: { text: 'Sponsorship' }, cy: { text: '2012 Mystery Event' } } },
        { id: '9', name: 'g9', values: { gt: { text: 'Membership' }, cy: { text: '2014 Not A Sponsorship' } } },
      ],
    },
    [SPONS]: {
      columns: [{ id: 'ev', title: 'Event', type: 'status', settings_str: JSON.stringify({ labels: { 1: 'Annual Gala', 2: 'BTWD' } }) }],
    },
  };
  const args = { command: 'cycles', organizations: ORGS, donations: DON, sponsorships: SPONS, out: '/tmp/x/data/cycles.csv' };
  it('reads every ledgered sponsorship, archived or not, and exits 1 while anything is unmapped', async () => {
const m = fakeMonday(boards);
    const files = {};
    const s = sink();
    const code = await run(
      args,
      { gql: m.gql, ...s, eventNames: { Dinner: 'Annual Gala' }, writeFile: (p, c) => (files[p] = c) },
    );
    assert.equal(code, 1);
    assert.match(files['/tmp/x/data/cycles.csv'], /^Event,Label,Years,Count\n/);
    assert.match(files['/tmp/x/data/cycles.csv'], /Mystery Event,,2012,1/);
    assert.doesNotMatch(files['/tmp/x/data/cycles.csv'], /Not A Sponsorship/);
    assert.equal(m.mutations.length, 0);
  });
  it('treats a label the board lacks as unmapped', async () => {
    const m = fakeMonday(boards);
    const code = await run(
      args,
      { gql: m.gql, ...sink(), eventNames: { Dinner: 'Dinner Party', 'Mystery Event': 'BTWD' }, writeFile: () => {} },
    );
    assert.equal(code, 1);
  });
  it('exits 0 when everything maps to a real label', async () => {
    const m = fakeMonday(boards);
    const code = await run(
      args,
      { gql: m.gql, ...sink(), eventNames: { Dinner: 'Annual Gala', 'Mystery Event': 'BTWD' }, writeFile: () => {} },
    );
    assert.equal(code, 0);
  });
});

describe('cycleReport with combined cycles', () => {
  it('counts each part of a combined cycle under its own event', () => {
    const r = cycleReport([{ cycle: '2016 Dinner / 2017 BTWD', giftType: 'Sponsorship' }], {}, ['Sponsorship']);
    assert.deepEqual(r.byEvent.map((e) => [e.event, e.years]).sort(), [['BTWD', [2017]], ['Dinner', [2016]]]);
  });
});

import { planPipelineLinks } from './sponsor-outreach-setup.mjs';
import { buildOrgIndex } from './lib/sponsor-outreach-setup.mjs';

describe('planPipelineLinks', () => {
  const idx = buildOrgIndex([
    { id: 'o1', name: 'Waymo LLC' },
    { id: 'o2', name: 'Cruise' },
    { id: 'o3', name: 'Cruise, Inc.' },
    { id: 'o4', name: 'Alta Planning + Design, Inc.' },
  ]);
  const p = planPipelineLinks(
    [
      { id: 'i1', name: 'Waymo', employer: null, linked: [] },
      { id: 'i2', name: 'Alta Planning and Design Group', employer: 'Alta Planning + Design', linked: [] },
      { id: 'i3', name: 'Veo', employer: null, linked: [] },
      { id: 'i4', name: 'Cruise', employer: null, linked: [] },
      { id: 'i5', name: 'Whatever', employer: null, linked: ['o9'] },
    ],
    idx,
  );
  it('links by name, then Employer', () => assert.deepEqual(p.link, [{ itemId: 'i1', orgId: 'o1' }, { itemId: 'i2', orgId: 'o4' }]));
  it('reviews unmatched and ambiguous', () =>
    assert.deepEqual(p.review, [
      { itemId: 'i3', reason: 'unmatched', candidates: [] },
      { itemId: 'i4', reason: 'ambiguous', candidates: ['o2', 'o3'] },
    ]));
  it('leaves an already-linked item alone', () => assert.equal(p.already, 1));
});

describe('link-pipeline command', () => {
  const boards = () => ({
    [ORGS]: { columns: [{ id: 'sf', title: '📜 Salesforce ID', type: 'text' }], items: [{ id: '501', name: 'Waymo LLC' }, { id: '502', name: 'Veo Inc' }] },
    [SPONS]: {
      columns: [{ id: 'emp', title: 'Employer', type: 'text' }, { id: 'org', title: 'Organization', type: 'board_relation' }],
      items: [
        { id: 'i1', name: 'Waymo', values: { emp: { text: null }, org: { linked: [] } } },
        { id: 'i2', name: 'Nobody', values: { emp: { text: null }, org: { linked: [] } } },
        { id: 'i3', name: 'Veo', values: { emp: { text: null }, org: { linked: ['502'] } } },
      ],
    },
  });
  const args = { command: 'link-pipeline', organizations: ORGS, sponsorships: SPONS, out: '/tmp/x/data/links.csv', apply: false };
  it('a dry run writes the review file, no mutation, exit 1 for review items', async () => {
    const m = fakeMonday(boards());
    const files = {};
    assert.equal(await run(args, { gql: m.gql, ...sink(), writeFile: (p, c) => (files[p] = c) }), 1);
    assert.equal(m.mutations.length, 0);
    assert.match(files['/tmp/x/data/links.csv'], /i2/);
  });
  it('--apply links exactly the matched, unlinked items', async () => {
    const m = fakeMonday(boards());
    await run({ ...args, apply: true }, { gql: m.gql, ...sink(), writeFile: () => {} });
    assert.deepEqual(m.mutations.map((x) => [x.vars.item, JSON.parse(x.vars.values)]), [['i1', { org: { item_ids: [501] } }]]);
  });
  it('a dry run works before the column exists; --apply refuses', async () => {
    const b = boards();
    b[SPONS].columns = b[SPONS].columns.filter((c) => c.id !== 'org');
    const m = fakeMonday(b);
    assert.equal(await run(args, { gql: m.gql, ...sink(), writeFile: () => {} }), 1);
    assert.equal(await run({ ...args, apply: true }, { gql: m.gql, ...sink(), writeFile: () => {} }), 2);
    assert.equal(m.mutations.length, 0);
  });
});

import { planProspects } from './sponsor-outreach-setup.mjs';

describe('planProspects', () => {
  const idx = buildOrgIndex([{ id: '1', name: 'AECOM' }, { id: '2', name: 'Adobe Systems, Inc.' }, { id: '3', name: 'Meta' }, { id: '4', name: 'Dup' }, { id: '5', name: 'Dup LLC' }, { id: '6', name: 'Gilead' }]);
  const current = new Map([['3', { prospect: true, notes: '' }], ['2', { prospect: false, notes: 'Called in May' }]]);
  const p = planProspects(
    [
      { company: 'AECOM', notes: 'warm' },
      { company: 'Adobe Systems', notes: 'Hold' },
      { company: 'Meta', notes: '' },
      { company: 'Gilead', notes: 'REMOVE - no budget' },
      { company: 'Dup', notes: '' },
      { company: 'Nowhere Co', notes: '' },
      { company: '', notes: '' },
    ],
    idx,
    current,
  );
  it('ticks matches, keeping existing notes', () => assert.deepEqual(p.set, [{ orgId: '1', notes: 'warm' }, { orgId: '2', notes: null }]));
  it('counts already-ticked', () => assert.equal(p.already, 1));
  it('reviews remove, ambiguous and unmatched; skips blank rows', () =>
    assert.deepEqual(p.review.map((r) => [r.company, r.reason]), [['Gilead', 'marked remove'], ['Dup', 'ambiguous'], ['Nowhere Co', 'unmatched']]));
});

describe('prospects command', () => {
  const boards = () => ({
    [ORGS]: {
      columns: [
        { id: 'sf', title: '📜 Salesforce ID', type: 'text' },
        { id: 'sp', title: 'Sponsor Prospect', type: 'checkbox' },
        { id: 'pn', title: 'Prospect Notes', type: 'text' },
      ],
      items: [{ id: '501', name: 'AECOM', values: { sp: { text: '' }, pn: { text: '' } } }],
    },
  });
  const csv = 'Notes for Outreach (EX: Hold or Remove etc),Type of sponsorship,Company\nwarm,all,AECOM\n,all,Nowhere\n';
  const args = { command: 'prospects', organizations: ORGS, input: '/tmp/x/data/p.csv', out: '/tmp/x/data/pr.csv', apply: false };
  it('--apply ticks and writes notes; exit 1 for review', async () => {
    const m = fakeMonday(boards());
    const code = await run({ ...args, apply: true }, { gql: m.gql, ...sink(), readFile: () => csv, writeFile: () => {} });
    assert.equal(code, 1);
    assert.deepEqual(m.mutations.map((x) => [x.vars.item, JSON.parse(x.vars.values)]), [['501', { sp: { checked: 'true' }, pn: 'warm' }]]);
  });
  it('a dry run sends nothing', async () => {
    const m = fakeMonday(boards());
    await run(args, { gql: m.gql, ...sink(), readFile: () => csv, writeFile: () => {} });
    assert.equal(m.mutations.length, 0);
  });
});
