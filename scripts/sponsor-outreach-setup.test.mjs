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
    const code = await run({ ...args, apply: true }, { gql: m.gql, ...sink(), readFile: (p) => { if (p.includes('applied-')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return csv; }, writeFile: () => {} });
    assert.equal(code, 1);
    assert.deepEqual(m.mutations.map((x) => [x.vars.item, JSON.parse(x.vars.values)]), [['501', { sp: { checked: 'true' }, pn: 'warm' }]]);
  });
  it('a dry run sends nothing', async () => {
    const m = fakeMonday(boards());
    await run(args, { gql: m.gql, ...sink(), readFile: (p) => { if (p.includes('applied-')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return csv; }, writeFile: () => {} });
    assert.equal(m.mutations.length, 0);
  });
});

import { planContacts, sheetSources } from './sponsor-outreach-setup.mjs';

describe('planContacts', () => {
  const affiliations = [
    { id: 'a1', personId: 'p1', orgId: 'o1', status: 'Current', workEmail: 'ann@acme.com', sponsorContact: false },
    { id: 'a2', personId: 'p2', orgId: 'o1', status: 'Former', workEmail: 'bob@acme.com', sponsorContact: false },
    { id: 'a3', personId: 'p3', orgId: 'o2', status: 'Current', workEmail: null, sponsorContact: false },
    { id: 'a4', personId: 'p4', orgId: 'o2', status: 'Current', workEmail: 'dee@beta.com', sponsorContact: true },
  ];
  const people = new Map([
    ['p1', { sfId: 'SF1', emails: ['ann@home.com'] }],
    ['p2', { sfId: 'SF2', emails: [] }],
    ['p3', { sfId: 'SF3', emails: ['cat@home.com'] }],
    ['p5', { sfId: null, emails: ['shared@home.com'] }],
    ['p6', { sfId: null, emails: ['shared@home.com'] }],
  ]);
  const orgsBySfId = new Map([['ACC1', 'o1'], ['ACC2', 'o2']]);
  const plan = (sources) => planContacts(sources, affiliations, people, orgsBySfId);
  it('ticks a Salesforce contact with a Current affiliation', () =>
    assert.deepEqual(plan([{ kind: 'salesforce', personSfId: 'SF1', orgSfId: 'ACC1' }]).tick, ['a1']));
  it('reviews a Salesforce contact with only a Former affiliation', () =>
    assert.equal(plan([{ kind: 'salesforce', personSfId: 'SF2', orgSfId: 'ACC1' }]).review[0].reason, 'former only'));
  it('reviews an unknown Salesforce contact or account', () => {
    assert.equal(plan([{ kind: 'salesforce', personSfId: 'SFX', orgSfId: 'ACC1' }]).review[0].reason, 'no person');
    assert.equal(plan([{ kind: 'salesforce', personSfId: 'SF1', orgSfId: 'ACCX' }]).review[0].reason, 'no organization');
  });
  it('ticks by Work Email', () => assert.deepEqual(plan([{ kind: 'email', email: 'ann@acme.com' }]).tick, ['a1']));
  it('reviews a Work Email on a Former affiliation', () =>
    assert.equal(plan([{ kind: 'email', email: 'bob@acme.com' }]).review[0].reason, 'former only'));
  it('falls back to the People email at the known organization', () =>
    assert.deepEqual(plan([{ kind: 'email', email: 'cat@home.com', orgId: 'o2' }]).tick, ['a3']));
  it('needs an organization for a People-only email', () =>
    assert.equal(plan([{ kind: 'email', email: 'cat@home.com' }]).review[0].reason, 'no organization'));
  it('reviews an email two People share', () =>
    assert.equal(plan([{ kind: 'email', email: 'shared@home.com', orgId: 'o1' }]).review[0].reason, 'several people share this email'));
  it('reviews an email nobody has', () => assert.equal(plan([{ kind: 'email', email: 'x@y.com' }]).review[0].reason, 'no person'));
  it('counts an already-ticked affiliation once and never re-ticks it', () => {
    const p = plan([{ kind: 'email', email: 'dee@beta.com' }, { kind: 'email', email: 'dee@beta.com' }]);
    assert.deepEqual([p.tick, p.already], [[], 1]);
  });
  it('ticks once when two sources reach one affiliation', () =>
    assert.deepEqual(plan([{ kind: 'salesforce', personSfId: 'SF1', orgSfId: 'ACC1' }, { kind: 'email', email: 'ann@acme.com' }]).tick, ['a1']));
});

describe('contacts command', () => {
  const PEOPLE = '600';
  const HIST = '700';
  const email = (e) => ({ text: e, value: JSON.stringify({ email: e, text: e }) });
  const boards = () => ({
    [ORGS]: {
      columns: [{ id: 'sf', title: '📜 Salesforce ID', type: 'text' }],
      items: [{ id: '501', name: 'Acme Inc', values: { sf: { text: '001000000000001AAA' } } }],
    },
    [AFFS]: {
      columns: [
        { id: 'st', title: 'Status', type: 'status' },
        { id: 'we', title: 'Work Email', type: 'email' },
        { id: 'pe', title: 'Person', type: 'board_relation' },
        { id: 'or', title: 'Organization', type: 'board_relation' },
        { id: 'sc', title: 'Sponsor Contact', type: 'checkbox' },
      ],
      items: [
        { id: '801', name: 'Ann at Acme', values: { st: { text: 'Current' }, we: email('Ann@Acme.com'), pe: { linked: ['601'] }, or: { linked: ['501'] }, sc: { text: '' } } },
        { id: '802', name: 'Cy at Acme', values: { st: { text: 'Current' }, we: { text: null }, pe: { linked: ['701'] }, or: { linked: ['501'] }, sc: { text: '' } } },
      ],
    },
    [PEOPLE]: {
      columns: [
        { id: 'psf', title: '📜 Salesforce ID', type: 'text' },
        { id: 'pem', title: 'Personal Email', type: 'email' },
        { id: 'dns', title: 'Do Not Solicit', type: 'checkbox' },
      ],
      items: [{ id: '601', name: 'Ann', values: { psf: { text: '003000000000001AAA' }, pem: email('ann@home.com'), dns: { text: '' } } }],
    },
    [HIST]: {
      columns: [
        { id: 'hsf', title: '📜 Salesforce ID', type: 'text' },
        { id: 'hem', title: 'Personal Email', type: 'email' },
        { id: 'hdns', title: 'Do Not Solicit', type: 'checkbox' },
      ],
      items: [{ id: '701', name: 'Cy', values: { hsf: { text: '003000000000002AAA' }, hem: email('cy@home.com'), hdns: { text: 'v' } } }],
    },
    [SPONS]: {
      columns: [{ id: 'em', title: 'Email', type: 'text' }, { id: 'org', title: 'Organization', type: 'board_relation' }],
      items: [{ id: '901', name: 'Acme', values: { em: { text: 'cy@home.com' }, org: { linked: ['501'] } } }],
    },
  });
  const files = {
    '/d/data/so/sf-primary-contacts.csv': 'npsp__Primary_Contact__c,AccountId\n003000000000001AAA,001000000000001AAA\n',
    '/d/data/so/sf-fundraise-opt-out.csv': 'Id\n003000000000002\n003000000000009AAA\n',
    '/d/data/so/sheet/Lapsed Donors.csv': 'Company,Email Address,other contacts\nAcme,ann@acme.com; nobody@acme.com,\n',
  };
  const args = {
    command: 'contacts', organizations: ORGS, affiliations: AFFS, people: PEOPLE, historical: HIST, sponsorships: SPONS,
    dir: '/d/data/so', out: '/d/data/so/contacts-review.csv', apply: true,
  };
  const deps = (m, written) => ({
    gql: m.gql, ...sink(),
    readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return files[p]; },
    listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1)),
    writeFile: (p, c) => (written[p] = c),
  });
  it('ticks from Salesforce, the sheet and the Sponsorships board, and reviews the rest', async () => {
    const m = fakeMonday(boards());
    const written = {};
    assert.equal(await run(args, deps(m, written)), 1);
    assert.deepEqual(m.mutations.map((x) => [x.vars.item, JSON.parse(x.vars.values)]).sort(), [
      ['801', { sc: { checked: 'true' } }],
      ['802', { sc: { checked: 'true' } }],
    ]);
    assert.match(written['/d/data/so/contacts-review.csv'], /nobody@acme\.com,no person/);
  });
  it('lists Fundraise Opt Out contacts with their Do Not Solicit state, never writing it', async () => {
    const m = fakeMonday(boards());
    const written = {};
    await run({ ...args, apply: false }, deps(m, written));
    const csv = written['/d/data/so/fundraise-opt-out.csv'];
    assert.match(csv, /^People Item ID,Monday Link,Do Not Solicit,Salesforce ID\n/);
    assert.match(csv, /701,https:\/\/bikesiliconvalley\.monday\.com\/boards\/700\/pulses\/701,yes,003000000000002/);
    assert.match(csv, /,,not in Monday,003000000000009AAA/);
    assert.equal(m.mutations.length, 0);
  });
});

describe('planContacts review rows', () => {
  it('lists one review row per source, key and reason', () => {
    const p = planContacts([{ kind: 'email', email: 'x@y.com' }, { kind: 'email', email: 'x@y.com' }], [], new Map(), new Map());
    assert.equal(p.review.length, 1);
  });
});

describe('final review fixes', () => {
  it('a Work Email on several people\'s Current affiliations is reviewed, not ticked', () => {
    const affs = [
      { id: 'a1', personId: 'p1', orgId: 'o1', status: 'Current', workEmail: 'info@acme.com', sponsorContact: false },
      { id: 'a2', personId: 'p2', orgId: 'o1', status: 'Current', workEmail: 'info@acme.com', sponsorContact: false },
    ];
    const p = planContacts([{ kind: 'email', email: 'info@acme.com' }], affs, new Map(), new Map());
    assert.deepEqual([p.tick, p.review.map((r) => r.reason)], [[], ['several people share this email']]);
  });

  it('prospects fills empty notes on an already-ticked Organization', () => {
    const idx = buildOrgIndex([{ id: '1', name: 'AECOM' }]);
    const p = planProspects([{ company: 'AECOM', notes: 'warm' }], idx, new Map([['1', { prospect: true, notes: '' }]]));
    assert.deepEqual([p.set, p.already], [[{ orgId: '1', notes: 'warm', notesOnly: true }], 0]);
  });

  it('an --apply never re-writes an id an earlier --apply recorded, even after Martha undid it', async () => {
    const boards = {
      [ORGS]: { columns: [{ id: 'sf', title: '📜 Salesforce ID', type: 'text' }], items: [{ id: '501', name: 'Waymo LLC' }] },
      [SPONS]: {
        columns: [{ id: 'emp', title: 'Employer', type: 'text' }, { id: 'org', title: 'Organization', type: 'board_relation' }],
        items: [{ id: 'i1', name: 'Waymo', values: { emp: { text: null }, org: { linked: [] } } }],
      },
    };
    const files = {};
    const deps = (m) => ({ gql: m.gql, ...sink(), readFile: (p) => { if (!(p in files)) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return files[p]; }, writeFile: (p, c) => (files[p] = c) });
    const args = { command: 'link-pipeline', organizations: ORGS, sponsorships: SPONS, out: '/t/data/l.csv', apply: true };
    const first = fakeMonday(boards);
    await run(args, deps(first));
    assert.equal(first.mutations.length, 1);
    const second = fakeMonday(boards); // Martha cleared the link; the item reads unlinked again
    await run(args, deps(second));
    assert.equal(second.mutations.length, 0);
  });

  it('contacts stops when the sheet directory is missing', async () => {
    const m = fakeMonday({});
    const ctx = { readFile: () => '', listDir: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } };
    assert.throws(() => sheetSources({ ...ctx, out: () => {} }, '/d/data/so', new Map()), /sheet/);
    void m;
  });

  it('contacts reads sheet headers case-insensitively and reports each tab', () => {
    const lines = [];
    const ctx = {
      out: (l) => lines.push(l),
      listDir: () => ['Lapsed.csv', 'Dinner Focused.csv'],
      readFile: (p) => (p.endsWith('Lapsed.csv') ? 'company,EMAIL\nAcme,a@acme.com\n' : 'Sponsor Names:,Events\nGoogle,Dinner\n'),
    };
    const s = sheetSources(ctx, '/d/data/so', buildOrgIndex([{ id: '1', name: 'Acme' }]));
    assert.deepEqual(s, [{ kind: 'email', email: 'a@acme.com', orgId: '1' }]);
    assert.ok(lines.some((l) => /Lapsed\.csv: 1 address/.test(l)));
    assert.ok(lines.some((l) => /Dinner Focused\.csv: skipped, no email column/.test(l)));
  });
});

import { prospectRecords } from './sponsor-outreach-setup.mjs';

describe('2026-11-16 sheet layout', () => {
  it('prospects reads the Salesforce-style Prospects tab (Account Name, notes)', () =>
    assert.deepEqual(prospectRecords('Sponsorship Cycle,Account Name,notes,Primary Contact\n2024 BTWD,AECOM,closed?,X\n'), [
      { company: 'AECOM', notes: 'closed?' },
    ]));
  it('prospects still reads the old layout', () =>
    assert.deepEqual(prospectRecords('Notes for Outreach (EX: Hold or Remove etc),Company\nwarm,AECOM\n'), [{ company: 'AECOM', notes: 'warm' }]));
  it('prospects stops on a tab with neither layout', () => assert.throws(() => prospectRecords('a,b\n1,2\n'), /Company|Account Name/));
  it('contacts reads Contact: Email and Account Name columns', () => {
    const ctx = { out: () => {}, listDir: () => ['raw lapsed.csv'], readFile: () => 'Account Name,Contact: Email\nAcme,a@acme.com\n' };
    assert.deepEqual(sheetSources(ctx, '/d/data/so', buildOrgIndex([{ id: '1', name: 'Acme' }])), [{ kind: 'email', email: 'a@acme.com', orgId: '1' }]);
  });
});
