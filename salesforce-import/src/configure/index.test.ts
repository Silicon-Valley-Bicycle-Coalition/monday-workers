import { describe, it, expect } from 'vitest';
import { configureBoard, dashboardToken } from './index.js';
import { MondayClient } from '../load/monday.js';
import type { BoardSpec } from './spec.js';
import { COLS } from './testFixtures.js';

const SPEC: BoardSpec = {
  description: 'The real description.',
  groupTitle: 'People',
  columns: [{ title: 'Stakeholder Type', type: 'status', labels: ['Individual Donor', 'Elected Official'] }],
  columnDescriptions: { 'Stakeholder Type': 'advocacy classification' },
  views: [
    { name: 'Stakeholders', filter: { rules: [{ columnTitle: 'Stakeholder Type', operator: 'any_of', labelValues: ['Elected Official'] }] } },
  ],
  deleteStrayViews: ['Build Vibe view'],
};

function scriptedClient(calls: { query: string; variables: Record<string, unknown>; version?: string }[]): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    calls.push({ query, variables, version: (init as { headers: Record<string, string> }).headers['API-Version'] });
    if (/query\s*\(\$ids/.test(query)) {
      // Second fetch (post-creation refresh) reports the column as now present.
      const alreadyCreated = calls.some((c) => /mutation.*create_column/s.test(c.query));
      return Response.json({ data: { boards: [{
        description: null,
        groups: [{ id: 'g1', title: 'Group Title' }],
        columns: alreadyCreated
          ? [{ id: 'col_stake', title: 'Stakeholder Type', type: 'status', description: null,
              settings_str: JSON.stringify({ labels: { '1': 'Individual Donor', '2': 'Elected Official' } }) }]
          : [],
        views: [{ id: 'v_stray', name: 'Build Vibe view' }],
      }] } });
    }
    if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: 'col_stake' } } });
    if (/update_board/.test(query)) return Response.json({ data: { update_board: '{}' } });
    if (/update_group/.test(query)) return Response.json({ data: { update_group: { id: 'g1' } } });
    if (/delete_view/.test(query)) return Response.json({ data: { delete_view: { id: variables['view'] } } });
    if (/change_column_metadata/.test(query)) return Response.json({ data: { change_column_metadata: { id: variables['col'] } } });
    if (/create_view_table/.test(query)) return Response.json({ data: { create_view_table: { id: 'view_new' } } });
    if (/update_view_table/.test(query)) return Response.json({ data: { update_view_table: { id: variables['view'] } } });
    throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

describe('configureBoard', () => {
  it('applies description, group rename, new column, stray-view delete, column description, and a view referencing the new column', async () => {
    const calls: { query: string; variables: Record<string, unknown>; version?: string }[] = [];
    const client = scriptedClient(calls);

    const result = await configureBoard(client, 900, SPEC, false);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/set description/);
    expect(result.summary).toMatch(/renamed default group/);
    expect(result.summary).toMatch(/created 1 column/);
    expect(result.summary).toMatch(/deleted 1 stray view/);
    expect(result.summary).toMatch(/set 1 column description/);
    expect(result.summary).toMatch(/created 1 view/);

    const viewCall = calls.find((c) => /create_view_table/.test(c.query));
    expect(viewCall?.variables['filter']).toEqual({ operator: 'and', rules: [{ column_id: 'col_stake', operator: 'any_of', compare_value: [2] }] });

    // conditional_formatting_settings exists only in API 2026-10; everything else stays on the pin.
    expect(viewCall?.version).toBe('2026-10');
    for (const c of calls.filter((x) => !/create_view_table|update_view_table/.test(x.query))) expect(c.version).toBe('2026-01');

    const descCall = calls.find((c) => /change_column_metadata/.test(c.query));
    expect(descCall?.variables).toMatchObject({ col: 'col_stake', value: 'advocacy classification' });
  });

  it('dry-run makes no mutating calls', async () => {
    const calls: { query: string; variables: Record<string, unknown>; version?: string }[] = [];
    const client = scriptedClient(calls);

    const result = await configureBoard(client, 900, SPEC, true);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/would set description/);
    expect(calls.every((c) => /^query/.test(c.query))).toBe(true);
  });

  it('is idempotent: a fully-configured board reports "already up to date"', async () => {
    const fetchFn = (async () => Response.json({ data: { boards: [{
      description: SPEC.description,
      groups: [{ id: 'g1', title: 'People' }],
      columns: [{ id: 'col_stake', title: 'Stakeholder Type', type: 'status',
        description: 'advocacy classification',
        settings_str: JSON.stringify({ labels: { '1': 'Individual Donor', '2': 'Elected Official' } }) }],
      views: [{ id: 'v1', name: 'Stakeholders' }],
    }] } })) as unknown as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    const result = await configureBoard(client, 900, SPEC, false);
    expect(result.summary).toBe('re-applied 1 view(s)');
  });
});

const SPEC_WITH_DONORS_VIEW: BoardSpec = {
  description: 'x', groupTitle: 'People', columns: [], columnDescriptions: {},
  views: [{ name: 'Donors', columns: ['Personal Email'], groupBy: { columnTitle: 'Donor Level' },
    coloring: [{ columnTitle: 'Donor Level', labelValues: ['Major'], color: 'red' }], tag: 'Report' }],
  deleteStrayViews: [],
};

async function runWithFakeBoard(
  boardOverrides: { views: { id: string; name: string }[] }, spec: BoardSpec, { dryRun }: { dryRun?: boolean } = {},
) {
  const calls: { query: string; variables: Record<string, unknown>; version?: string }[] = [];
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    calls.push({ query, variables, version: (init as { headers: Record<string, string> }).headers['API-Version'] });
    if (/^\s*query/.test(query)) {
      return Response.json({ data: { boards: [{ description: 'x', groups: [{ id: 'g', title: spec.groupTitle }], columns: COLS, ...boardOverrides }] } });
    }
    if (/create_view_table/.test(query)) return Response.json({ data: { create_view_table: { id: '1' } } });
    if (/update_view_table/.test(query)) return Response.json({ data: { update_view_table: { id: '1' } } });
    throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
  }) as typeof fetch;
  const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
  await configureBoard(client, 1, spec, dryRun ?? false);
  return calls;
}

describe('configureBoard — spec views', () => {
  it('creates missing spec views with settings, tags, and colouring via create_view_table', async () => {
    const calls = await runWithFakeBoard({ views: [] }, SPEC_WITH_DONORS_VIEW);
    const create = calls.find((c) => c.query.includes('create_view_table'))!;
    expect(create.variables).toMatchObject({ name: 'Donors', tags: ['Report'],
      settings: { group_by: { conditions: [{ columnId: 'dl' }] } } });
    expect(create.variables['conditional_formatting_settings']).toHaveLength(1);
  });

  it('updates an existing spec view by id instead of creating a duplicate', async () => {
    const calls = await runWithFakeBoard({ views: [{ id: '77', name: 'Donors' }] }, SPEC_WITH_DONORS_VIEW);
    expect(calls.some((c) => c.query.includes('create_view_table'))).toBe(false);
    expect(calls.find((c) => c.query.includes('update_view_table'))!.variables).toMatchObject({ view: '77' });
  });

  it('never touches a view whose name is not in the spec', async () => {
    const calls = await runWithFakeBoard({ views: [{ id: '88', name: "Deanna's list" }] }, SPEC_WITH_DONORS_VIEW);
    expect(calls.some((c) => JSON.stringify(c.variables).includes('"88"'))).toBe(false);
  });

  it('dry-run reports creates and updates without calling mutations', async () => {
    const calls = await runWithFakeBoard({ views: [{ id: '77', name: 'Donors' }] }, SPEC_WITH_DONORS_VIEW, { dryRun: true });
    expect(calls.every((c) => !c.query.trimStart().startsWith('mutation'))).toBe(true);
  });
});

describe('dashboardToken', () => {
  it('prefers MONDAY_DASHBOARD_TOKEN, falls back to MONDAY_API_TOKEN', () => {
    expect(dashboardToken({ MONDAY_DASHBOARD_TOKEN: 'd', MONDAY_API_TOKEN: 'a' })).toBe('d');
    expect(dashboardToken({ MONDAY_API_TOKEN: 'a' })).toBe('a');
    expect(dashboardToken({ MONDAY_DASHBOARD_TOKEN: '', MONDAY_API_TOKEN: 'a' })).toBe('a');
    expect(dashboardToken({})).toBeUndefined();
  });
});
