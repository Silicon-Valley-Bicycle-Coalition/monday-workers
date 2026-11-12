import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columnDefaults, leadFromItem, parseArgs, planBuild, planConversions, run } from './funding-leads-board.mjs';
import { DEAL_EXTRA_COLUMNS, LEADS_COLUMNS, STAGES } from './lib/funding-leads.mjs';

const WS = '18210301';

describe('parseArgs', () => {
  it('requires a workspace for build', () => assert.throws(() => parseArgs(['build']), /--workspace/));
  it('reads build flags', () => {
    const a = parseArgs(['build', '--workspace', WS, '--organizations', '11', '--apply']);
    assert.equal(a.command, 'build');
    assert.equal(a.workspace, WS);
    assert.equal(a.organizations, '11');
    assert.equal(a.apply, true);
  });
  it('rejects an unknown flag', () => assert.throws(() => parseArgs(['build', '--workspace', WS, '--nope', '1']), /unknown/));
});

describe('columnDefaults', () => {
  it('lists status labels by index with Pledged marked done', () => {
    const d = JSON.parse(columnDefaults({ title: 'Stage', type: 'status', settings: { labels: STAGES } }));
    const pledged = Object.entries(d.labels).find(([, l]) => l === 'Pledged')?.[0];
    assert.ok(pledged);
    assert.equal(d.labels_colors[pledged].is_done, true);
  });
  it('lists dropdown labels', () => {
    const d = JSON.parse(columnDefaults({ title: 'Type', type: 'dropdown', settings: { labels: [{ label: 'Grant' }] } }));
    assert.deepEqual(d.settings.labels, [{ id: 1, label: 'Grant' }]);
  });
  it('points a relation at its board', () => {
    const d = JSON.parse(columnDefaults({ title: 'Organization', type: 'board_relation' }, [42]));
    assert.deepEqual(d.boardIds, [42]);
  });
});

describe('planBuild', () => {
  const opts = { organizations: '11' };
  it('plans both boards and every column on an empty workspace', () => {
    const steps = planBuild([], opts);
    assert.deepEqual(
      steps.filter((s) => s.kind === 'create_board').map((s) => s.key),
      ['leads', 'deals'],
    );
    const leadCols = steps.filter((s) => s.kind === 'create_column' && s.board === 'leads');
    assert.equal(leadCols.length, LEADS_COLUMNS.length);
    const dealCols = steps.filter((s) => s.kind === 'create_column' && s.board === 'deals');
    assert.equal(dealCols.length, DEAL_EXTRA_COLUMNS.length);
  });
  it('plans only missing columns when the board exists', () => {
    const existing = [
      { id: '1', name: 'Funding Leads', columns: LEADS_COLUMNS.slice(1).map((c) => ({ title: c.title })) },
      { id: '2', name: 'Deals', columns: DEAL_EXTRA_COLUMNS.map((c) => ({ title: `🔒 ${c.title}` })) },
    ];
    const steps = planBuild(existing, opts);
    assert.deepEqual(steps.map((s) => `${s.kind}:${s.column?.title}`), [`create_column:${LEADS_COLUMNS[0].title}`]);
  });
  it('is empty when everything exists', () => {
    const existing = [
      { id: '1', name: 'Funding Leads', columns: LEADS_COLUMNS.map((c) => ({ title: c.title })) },
      { id: '2', name: 'Deals', columns: DEAL_EXTRA_COLUMNS.map((c) => ({ title: c.title })) },
    ];
    assert.deepEqual(planBuild(existing, opts), []);
  });
  it('extends a Deals board instead of creating Opportunities', () => {
    const steps = planBuild([{ id: '2', name: 'Deals', columns: [] }], opts);
    assert.ok(!steps.some((s) => s.kind === 'create_board' && s.key === 'deals'));
  });
});

function fakeGql(boards = []) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (/mutation/.test(query) && /create_board/.test(query)) return { create_board: { id: String(900 + calls.length) } };
    if (/mutation/.test(query)) return { create_column: { id: `c${calls.length}` } };
    return { boards };
  };
  return { gql, calls };
}
const sink = () => {
  const lines = [];
  return { out: (l) => lines.push(l), err: (l) => lines.push(l), lines };
};

describe('run build', () => {
  it('refuses the production workspace before any request', async () => {
    const { gql, calls } = fakeGql();
    const s = sink();
    const code = await run(parseArgs(['build', '--workspace', '10001654', '--organizations', '11']), { gql, ...s });
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
  });
  it('sends no mutation without --apply', async () => {
    const { gql, calls } = fakeGql();
    const s = sink();
    const code = await run(parseArgs(['build', '--workspace', WS, '--organizations', '11']), { gql, ...s });
    assert.equal(code, 0);
    assert.ok(calls.every((c) => !/mutation/.test(c.query)));
  });
  it('creates boards then columns with --apply and never duplicates a board', async () => {
    const { gql, calls } = fakeGql();
    const s = sink();
    const code = await run(parseArgs(['build', '--workspace', WS, '--organizations', '11', '--apply']), { gql, ...s });
    assert.equal(code, 0);
    assert.ok(calls.some((c) => /create_board/.test(c.query)));
    assert.ok(calls.every((c) => !/duplicate_board/.test(c.query)));
  });
});

describe('planConversions', () => {
  const lead = (over = {}) => ({
    id: '1',
    name: 'Example Co',
    stage: 'Pledged',
    dealLinked: false,
    organization: ['11'],
    contact: [],
    amount: '5000',
    owner: null,
    types: ['Sponsorship'],
    events: ['BTWD'],
    ...over,
  });
  it('converts a Pledged lead with no Deal link', () => {
    const [c] = planConversions([lead()]);
    assert.equal(c.leadId, '1');
    assert.deepEqual(c.deal.events, ['BTWD']);
    assert.deepEqual(c.deal.types, ['Sponsorship']);
  });
  it('skips a Pledged lead that already has a Deal', () =>
    assert.deepEqual(planConversions([lead({ dealLinked: true })]), []));
  it('skips leads that are not Pledged', () =>
    assert.deepEqual(planConversions([lead({ stage: 'Research' }), lead({ stage: 'Lost' })]), []));
  it('is empty once the link is set, so a second pass or a Pledged round trip adds nothing', () => {
    const leads = [lead()];
    assert.equal(planConversions(leads).length, 1);
    leads[0].dealLinked = true;
    assert.equal(planConversions(leads).length, 0);
  });
});

describe('leadFromItem', () => {
  const cols = { Stage: 's', Deal: 'd', Organization: 'o', Amount: 'a', Type: 't', 'Events of interest': 'e' };
  const item = (deal) => ({
    id: '9',
    name: 'Example Co',
    column_values: [
      { id: 's', text: 'Pledged', value: null },
      { id: 'd', text: '', value: deal },
      { id: 'o', text: 'Org', value: '{"linkedPulseIds":[{"linkedPulseId":11}]}' },
      { id: 'a', text: '5000', value: '"5000"' },
      { id: 't', text: 'Grant, Sponsorship', value: null },
      { id: 'e', text: 'BTWD, Dinner', value: null },
    ],
  });
  it('reads stage, links and multi-select labels', () => {
    const l = leadFromItem(item(null), cols);
    assert.equal(l.stage, 'Pledged');
    assert.equal(l.dealLinked, false);
    assert.deepEqual(l.organization, ['11']);
    assert.deepEqual(l.types, ['Grant', 'Sponsorship']);
    assert.deepEqual(l.events, ['BTWD', 'Dinner']);
  });
  it('sees a linked Deal', () =>
    assert.equal(leadFromItem(item('{"linkedPulseIds":[{"linkedPulseId":77}]}'), cols).dealLinked, true));
});

// A stateful fake of the two boards: enough to prove convert is idempotent end to end.
function convertFake() {
  const state = { linked: false, created: 0, linkWrites: 0 };
  const cols = (titles) => titles.map((t) => ({ id: `id_${t}`, title: t, type: 'text' }));
  const gql = async (query) => {
    if (/create_item/.test(query)) {
      state.created += 1;
      return { create_item: { id: '500' } };
    }
    if (/change_multiple_column_values/.test(query)) {
      state.linked = true;
      state.linkWrites += 1;
      return { change_multiple_column_values: { id: '1' } };
    }
    if (/items\(ids/.test(query))
      return { items: [{ id: '1', column_values: [{ value: state.linked ? '{"linkedPulseIds":[{"linkedPulseId":500}]}' : null }] }] };
    if (/items_page/.test(query))
      return {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '1',
                  name: 'Example Co',
                  column_values: [
                    { id: 'id_Stage', text: 'Pledged', value: null },
                    { id: 'id_Deal', text: '', value: state.linked ? '{"linkedPulseIds":[{"linkedPulseId":500}]}' : null },
                  ],
                },
              ],
            },
          },
        ],
      };
    return {
      boards: [
        { id: '7', columns: cols(['Stage', 'Deal', 'Organization', 'Contact', 'Amount', 'Owner', 'Type', 'Events of interest']) },
        { id: '8', columns: cols(['Type', 'Events of interest', 'Lead', 'Organization', 'Contact', 'Amount', 'Owner']) },
      ],
    };
  };
  return { gql, state };
}

describe('run convert', () => {
  const argv = ['convert', '--workspace', WS, '--leads', '7', '--deals', '8'];
  it('refuses the production workspace', async () => {
    const { gql, state } = convertFake();
    const code = await run(parseArgs(['convert', '--workspace', '10001654', '--leads', '7', '--deals', '8', '--apply']), { gql, ...sink() });
    assert.equal(code, 2);
    assert.equal(state.created, 0);
  });
  it('writes nothing without --apply', async () => {
    const { gql, state } = convertFake();
    assert.equal(await run(parseArgs(argv), { gql, ...sink() }), 0);
    assert.equal(state.created, 0);
  });
  it('creates one Deal and links it, and a second run creates none', async () => {
    const { gql, state } = convertFake();
    assert.equal(await run(parseArgs([...argv, '--apply']), { gql, ...sink() }), 0);
    assert.equal(state.created, 1);
    assert.equal(await run(parseArgs([...argv, '--apply']), { gql, ...sink() }), 0);
    assert.equal(state.created, 1);
  });
});
