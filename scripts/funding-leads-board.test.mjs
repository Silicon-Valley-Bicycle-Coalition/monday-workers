import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columnDefaults, parseArgs, planBuild, run } from './funding-leads-board.mjs';
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
