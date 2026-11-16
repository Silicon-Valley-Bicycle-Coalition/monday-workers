import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { columnDefaults, leadFromItem, parseArgs, parseCsv, planBuild, planConversions, planSeed, run } from './funding-leads-board.mjs';
import { DEAL_EXTRA_COLUMNS, LEADS_COLUMNS, STAGES, mapSheetRow } from './lib/funding-leads.mjs';

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

function fakeGql(boards = [], foreign = new Set()) {
  const calls = [];
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: foreign.has(String(id)) ? '10001654' : WS } })) };
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
  // Relation links come back in linked_item_ids; their `value` is null (verified against the live API).
  const item = (deal) => ({
    id: '9',
    name: 'Example Co',
    column_values: [
      { id: 's', text: 'Pledged', value: null },
      { id: 'd', text: '', value: null, linked_item_ids: deal },
      { id: 'o', text: 'Org', value: null, linked_item_ids: ['11'] },
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
    assert.equal(leadFromItem(item(['77']), cols).dealLinked, true));
});

// A stateful fake of the two boards: enough to prove convert is idempotent end to end.
function convertFake(foreign = new Set()) {
  const state = { linked: false, created: 0, linkWrites: 0 };
  const cols = (titles) => titles.map((t) => ({ id: `id_${t}`, title: t, type: 'text' }));
  const gql = async (query, variables) => {
    if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: foreign.has(String(id)) ? '10001654' : WS } })) };
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
      return { items: [{ id: '1', column_values: [{ linked_item_ids: state.linked ? ['500'] : [] }] }] };
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
                    { id: 'id_Deal', text: '', value: null, linked_item_ids: state.linked ? ['500'] : [] },
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

describe('parseCsv', () => {
  it('reads headers, quoted commas and doubled quotes', () => {
    const rows = parseCsv('Company,Notes\n"Acme, Inc.","said ""hi"""\nBeta,\n');
    assert.deepEqual(rows, [
      { Company: 'Acme, Inc.', Notes: 'said "hi"' },
      { Company: 'Beta', Notes: '' },
    ]);
  });
});

describe('planSeed', () => {
  const plan = (tab, row) => ({ tab, plan: mapSheetRow(tab, row) });
  const prospect = (name, cycle = '2024 BTWD') => plan('prospects', { 'Account Name': name, 'Sponsorship Cycle': cycle });
  it('creates one organization for two rows of the same company', () => {
    const r = planSeed([prospect('Example Co', '2023 BTWD'), prospect('example  co', '2024 Dinner')], []);
    assert.equal(r.orgCreates.length, 1);
    assert.equal(r.leadCreates.length, 2);
  });
  it('keeps near-match organizations separate and flags the pair for review', () => {
    const r = planSeed([prospect('Applied Materials'), prospect('Applied Materials Foundation')], []);
    assert.equal(r.orgCreates.length, 2);
    assert.equal(r.reviewPairs.length, 1);
  });
  it('links an organization that already exists instead of creating it', () => {
    const r = planSeed([prospect('Example Co')], [{ id: '5', name: 'EXAMPLE CO' }]);
    assert.equal(r.orgCreates.length, 0);
    assert.equal(r.leadCreates[0].orgId, '5');
  });
  it('drops an exact duplicate row but keeps a different event for the same company', () => {
    const r = planSeed([prospect('Example Co', '2024 BTWD'), prospect('Example Co', '2024 BTWD'), prospect('Example Co', '2024 Dinner')], []);
    assert.equal(r.leadCreates.length, 2);
  });
  it('still creates a lead for a row with no event, contact or amount, and counts a blank-company row', () => {
    const r = planSeed([plan('prospects', { 'Account Name': 'Bare Co' }), plan('prospects', { 'Account Name': ' ' })], []);
    assert.equal(r.leadCreates.length, 1);
    assert.equal(r.skippedBlank, 1);
  });
});

describe('run seed', () => {
  function seedFixture(foreign = new Set()) {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    writeFileSync(join(dir, 'active.csv'), 'Event,Type,Company,Scheduled Meeting,Staff Lead,Grant Amount\nBTWD,Local,Example Co,FALSE,,5000\n');
    writeFileSync(join(dir, 'prospects.csv'), 'Sponsorship Cycle,Account Name\n2024 BTWD,Other Co\n');
    writeFileSync(join(dir, 'lapsed.csv'), 'Type of sponsorship,Company\n2018 Dinner,Old Co\n');
    let n = 100;
    const calls = { creates: 0, mutations: 0 };
    const cols = ['Organization', 'Stage', 'Type', 'Events of interest', 'BTWD tier', 'Funder Status', 'Amount'].map((t) => ({ id: `id_${t}`, title: t, type: 'text' }));
    const gql = async (query, variables) => {
      if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: foreign.has(String(id)) ? '10001654' : WS } })) };
      if (/mutation/.test(query)) {
        calls.mutations += 1;
        calls.creates += 1;
        return { create_item: { id: String(n++) } };
      }
      if (/items_page/.test(query)) return { boards: [{ items_page: { cursor: null, items: [] } }] };
      return { boards: [{ id: '7', columns: cols }] };
    };
    return { dir, gql, calls };
  }
  const argv = (dir, extra = []) => ['seed', '--workspace', WS, '--leads', '7', '--orgs', '11', '--data', dir, ...extra];
  it('dry run writes a review file and no mutation', async () => {
    const { dir, gql, calls } = seedFixture();
    assert.equal(await run(parseArgs(argv(dir)), { gql, ...sink() }), 0);
    assert.equal(calls.mutations, 0);
    assert.ok(existsSync(join(dir, 'review.txt')));
  });
  it('apply creates everything once and a re-run skips what the ledger holds', async () => {
    const { dir, gql, calls } = seedFixture();
    assert.equal(await run(parseArgs(argv(dir, ['--apply'])), { gql, ...sink() }), 0);
    const first = calls.creates;
    assert.equal(first, 6); // 3 organizations + 3 leads
    assert.equal(await run(parseArgs(argv(dir, ['--apply'])), { gql, ...sink() }), 0);
    assert.equal(calls.creates, first);
    assert.equal(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).leads.length, 3);
  });
  it('refuses the production workspace', async () => {
    const { dir, gql, calls } = seedFixture();
    const code = await run(parseArgs(['seed', '--workspace', '10001654', '--leads', '7', '--orgs', '11', '--data', dir, '--apply']), { gql, ...sink() });
    assert.equal(code, 2);
    assert.equal(calls.mutations, 0);
  });
});

describe('every board id must belong to the sandbox workspace', () => {
  it('build refuses an Organizations board outside the sandbox', async () => {
    const { gql, calls } = fakeGql([], new Set(['11']));
    const code = await run(parseArgs(['build', '--workspace', WS, '--organizations', '11', '--apply']), { gql, ...sink() });
    assert.equal(code, 2);
    assert.ok(calls.every((c) => !/mutation/.test(c.query)));
  });
  it('convert refuses a Deals board outside the sandbox', async () => {
    const { gql, state } = convertFake(new Set(['8']));
    const code = await run(parseArgs(['convert', '--workspace', WS, '--leads', '7', '--deals', '8', '--apply']), { gql, ...sink() });
    assert.equal(code, 2);
    assert.equal(state.created, 0);
  });
  it('convert refuses a board that does not exist', async () => {
    const gql = async () => ({ boards: [] });
    assert.equal(await run(parseArgs(['convert', '--workspace', WS, '--leads', '7', '--deals', '8', '--apply']), { gql, ...sink() }), 2);
  });
  it('seed refuses an Organizations board outside the sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    for (const f of ['active', 'prospects', 'lapsed']) writeFileSync(join(dir, `${f}.csv`), 'Company\nX\n');
    const { gql, calls } = (() => {
      const calls = { mutations: 0 };
      return {
        calls,
        gql: async (query, variables) => {
          if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: id === '11' ? '10001654' : WS } })) };
          if (/mutation/.test(query)) calls.mutations += 1;
          return { boards: [{ id: '7', columns: [], items_page: { cursor: null, items: [] } }] };
        },
      };
    })();
    const code = await run(parseArgs(['seed', '--workspace', WS, '--leads', '7', '--orgs', '11', '--data', dir, '--apply']), { gql, ...sink() });
    assert.equal(code, 2);
    assert.equal(calls.mutations, 0);
  });
});

describe('parseCsv robustness', () => {
  it('strips a byte-order mark and trims headers', () =>
    assert.deepEqual(parseCsv('\ufeffCompany , Notes\nAcme,x\n'), [{ Company: 'Acme', Notes: 'x' }]));
  it('reads CRLF line endings and a quoted newline', () =>
    assert.deepEqual(parseCsv('Company,Notes\r\nAcme,"a\nb"\r\n'), [{ Company: 'Acme', Notes: 'a\nb' }]));
});

describe('hardening from the final review', () => {
  // I1: a Deal that already names this lead (left by a crash) is linked, not duplicated.
  it('convert repairs the link to an orphan Deal instead of creating another', async () => {
    const state = { creates: 0, links: 0 };
    const cols = (t) => t.map((x) => ({ id: `id_${x}`, title: x, type: 'text' }));
    const gql = async (query, variables) => {
      if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: WS } })) };
      if (/create_item/.test(query)) { state.creates += 1; return { create_item: { id: '501' } }; }
      if (/change_multiple_column_values/.test(query)) { state.links += 1; return { change_multiple_column_values: { id: '1' } }; }
      if (/items\(ids/.test(query)) return { items: [{ id: '1', column_values: [{ linked_item_ids: [] }] }] };
      if (/items_page/.test(query)) {
        const onDeals = String(variables.ids?.[0]) === '8';
        return { boards: [{ items_page: { cursor: null, items: onDeals
          ? [{ id: '500', name: 'x', column_values: [{ id: 'id_Lead', text: '', value: null, linked_item_ids: ['1'] }] }]
          : [{ id: '1', name: 'Example Co', column_values: [{ id: 'id_Stage', text: 'Pledged', value: null }, { id: 'id_Deal', text: '', value: null, linked_item_ids: [] }] }] } }] };
      }
      return { boards: [{ id: '7', columns: cols(['Stage', 'Deal', 'Lead']) }, { id: '8', columns: cols(['Lead', 'Type']) }] };
    };
    assert.equal(await run(parseArgs(['convert', '--workspace', WS, '--leads', '7', '--deals', '8', '--apply']), { gql, ...sink() }), 0);
    assert.equal(state.creates, 0);
    assert.equal(state.links, 1);
  });

  // I2: past the first 500 leads.
  it('convert reads every page of leads', async () => {
    const calls = [];
    const cols = (t) => t.map((x) => ({ id: `id_${x}`, title: x, type: 'text' }));
    const lead = (id, stage) => ({ id, name: 'L', column_values: [{ id: 'id_Stage', text: stage, value: null }, { id: 'id_Deal', text: '', value: null, linked_item_ids: [] }] });
    const gql = async (query, variables) => {
      calls.push(query);
      if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: WS } })) };
      if (/next_items_page/.test(query)) return { next_items_page: { cursor: null, items: [lead('2', 'Pledged')] } };
      if (/items_page/.test(query)) {
        if (String(variables.ids?.[0]) === '8') return { boards: [{ items_page: { cursor: null, items: [] } }] };
        return { boards: [{ items_page: { cursor: 'c1', items: [lead('1', 'Research')] } }] };
      }
      return { boards: [{ id: '7', columns: cols(['Stage', 'Deal']) }, { id: '8', columns: cols(['Lead']) }] };
    };
    const s = sink();
    assert.equal(await run(parseArgs(['convert', '--workspace', WS, '--leads', '7', '--deals', '8']), { gql, ...s }), 0);
    assert.ok(s.lines.some((l) => /1 Pledged lead/.test(l)), s.lines.join('|'));
  });

  // I4: a tab whose headers are wrong stops the run.
  it('seed exits 2 when a tab lacks its company column, instead of skipping every row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    writeFileSync(join(dir, 'active.csv'), 'Co,Event\nExample,BTWD\n');
    writeFileSync(join(dir, 'prospects.csv'), 'Account Name\nA\n');
    writeFileSync(join(dir, 'lapsed.csv'), 'Company\nB\n');
    const gql = async (q, v) => (/workspace \{ id \}/.test(q) ? { boards: v.ids.map((id) => ({ id, workspace: { id: WS } })) } : { boards: [{ id: '7', columns: [], items_page: { cursor: null, items: [] } }] });
    const s = sink();
    assert.equal(await run(parseArgs(['seed', '--workspace', WS, '--leads', '7', '--orgs', '11', '--data', dir]), { gql, ...s }), 2);
    assert.ok(s.lines.some((l) => /active\.csv/.test(l) && /Company/.test(l)));
  });

  // I5: rows collapsed by the dedupe key are counted, not silently lost.
  it('planSeed counts the rows it collapses', () => {
    const e = { tab: 'prospects', plan: mapSheetRow('prospects', { 'Account Name': 'Example Co', 'Sponsorship Cycle': '2024 BTWD' }) };
    assert.equal(planSeed([e, e], []).collapsed, 1);
  });

  // I6: near-matches that were missed, and noise that should not appear.
  it('flags punctuation, suffix and leading-"the" variants of a sheet company', () => {
    const p = (name) => ({ tab: 'prospects', plan: mapSheetRow('prospects', { 'Account Name': name }) });
    const pairs = (names, existing = []) => planSeed(names.map(p), existing).reviewPairs;
    assert.equal(pairs(['Google', 'Google, Inc.']).length, 1);
    assert.equal(pairs(['AT&T', 'AT & T']).length, 1);
    assert.equal(pairs(['The Acme Co', 'Acme Co']).length, 1);
  });
  it('does not list near-matches that involve no sheet company', () =>
    assert.equal(planSeed([{ tab: 'prospects', plan: mapSheetRow('prospects', { 'Account Name': 'Other Co' }) }], [{ id: '1', name: 'Smith' }, { id: '2', name: 'Smith Household' }]).reviewPairs.length, 0));
});

describe('seed interruption', () => {
  function fixture(failOnLead) {
    const dir = mkdtempSync(join(tmpdir(), 'seed-'));
    writeFileSync(join(dir, 'active.csv'), 'Event,Company\nBTWD,One Co\nBTWD,Two Co\n');
    writeFileSync(join(dir, 'prospects.csv'), 'Account Name\n');
    writeFileSync(join(dir, 'lapsed.csv'), 'Company\n');
    let leadCreates = 0;
    const cols = ['Organization', 'Stage'].map((t) => ({ id: `id_${t}`, title: t, type: 'text' }));
    const gql = async (query, variables) => {
      if (/workspace \{ id \}/.test(query)) return { boards: variables.ids.map((id) => ({ id, workspace: { id: WS } })) };
      if (/create_item/.test(query)) {
        if (String(variables.board) === '7' && ++leadCreates === failOnLead) throw new Error('boom');
        return { create_item: { id: String(1000 + Math.random() * 1000) } };
      }
      if (/items_page/.test(query)) return { boards: [{ items_page: { cursor: null, items: [] } }] };
      return { boards: [{ id: '7', columns: cols }] };
    };
    return { dir, gql };
  }
  const argv = (dir) => ['seed', '--workspace', WS, '--leads', '7', '--orgs', '11', '--data', dir, '--apply'];
  it('a run that dies mid-create refuses to resume until the operator checks Monday', async () => {
    const { dir, gql } = fixture(2);
    assert.equal(await run(parseArgs(argv(dir)), { gql, ...sink() }), 2);
    const s = sink();
    assert.equal(await run(parseArgs(argv(dir)), { gql: fixture(0).gql, ...s }), 2);
    assert.ok(s.lines.some((l) => /interrupted/i.test(l)));
  });
  it('refuses a ledger written for different boards', async () => {
    const { dir, gql } = fixture(0);
    assert.equal(await run(parseArgs(argv(dir)), { gql, ...sink() }), 0);
    const other = ['seed', '--workspace', WS, '--leads', '9', '--orgs', '11', '--data', dir, '--apply'];
    const s = sink();
    assert.equal(await run(parseArgs(other), { gql, ...s }), 2);
    assert.ok(s.lines.some((l) => /different boards/i.test(l)));
  });
});

describe('planSeed merges active rows by company', () => {
  const act = (company, event, amount, over = {}) => ({
    tab: 'active',
    plan: mapSheetRow('active', { Company: company, Event: event, 'Grant Amount': amount, 'Scheduled Meeting': 'FALSE', 'Staff Lead': '', ...over }),
  });
  it('makes one lead per company with the events unioned and the amounts summed', () => {
    const r = planSeed([act('Example Co', 'BTWD', '3000'), act('example co', 'Summit', '$4,000')], []);
    assert.equal(r.leadCreates.length, 1);
    assert.deepEqual(r.leadCreates[0].plan.events, ['BTWD', 'Advocacy Summit']);
    assert.equal(r.leadCreates[0].plan.amount, 7000);
  });
  it('does not double-count an event listed twice', () => {
    const r = planSeed([act('Example Co', 'BTWD', '3000'), act('Example Co', 'BTWD', '3000')], []);
    assert.equal(r.leadCreates[0].plan.amount, 3000);
    assert.equal(r.collapsed, 1);
  });
  it('sums what is known and leaves the amount empty only when every row is blank', () => {
    assert.equal(planSeed([act('A', 'BTWD', '3000'), act('A', 'Summit', '')], []).leadCreates[0].plan.amount, 3000);
    assert.equal(planSeed([act('A', 'BTWD', ''), act('A', 'Summit', '')], []).leadCreates[0].plan.amount, null);
  });
  it('keeps the furthest stage, the BTWD tier, and the union of owners', () => {
    const r = planSeed(
      [
        act('A', 'BTWD', '1', { Type: 'Local', 'Staff Lead': 'Ann A' }),
        act('A', 'Summit', '1', { 'Scheduled Meeting': 'TRUE', 'Staff Lead': 'Ann A, Bo B' }),
      ],
      [],
    );
    const p = r.leadCreates[0].plan;
    assert.equal(p.stage, 'Scheduled Meeting');
    assert.equal(p.btwdTier, 'Local');
    assert.deepEqual(p.owners, ['Ann A', 'Bo B']);
  });
  it('does not merge across tabs', () => {
    const pr = { tab: 'prospects', plan: mapSheetRow('prospects', { 'Account Name': 'A', 'Sponsorship Cycle': '2024 BTWD' }) };
    assert.equal(planSeed([act('A', 'BTWD', '1'), pr], []).leadCreates.length, 2);
  });
});
