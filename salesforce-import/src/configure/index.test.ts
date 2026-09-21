import { describe, it, expect } from 'vitest';
import { configureBoard } from './index.js';
import { MondayClient } from '../load/monday.js';
import type { BoardSpec } from './spec.js';

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

function scriptedClient(calls: { query: string; variables: Record<string, unknown> }[]): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    calls.push({ query, variables });
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
    if (/create_view/.test(query)) return Response.json({ data: { create_view: { id: 'view_new' } } });
    throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

describe('configureBoard', () => {
  it('applies description, group rename, new column, stray-view delete, column description, and a view referencing the new column', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const client = scriptedClient(calls);

    const result = await configureBoard(client, 900, SPEC, false);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/set description/);
    expect(result.summary).toMatch(/renamed default group/);
    expect(result.summary).toMatch(/created 1 column/);
    expect(result.summary).toMatch(/deleted 1 stray view/);
    expect(result.summary).toMatch(/set 1 column description/);
    expect(result.summary).toMatch(/created 1 view/);

    const viewCall = calls.find((c) => /create_view/.test(c.query));
    expect(viewCall?.variables['filter']).toEqual({ operator: 'and', rules: [{ column_id: 'col_stake', operator: 'any_of', compare_value: [2] }] });

    const descCall = calls.find((c) => /change_column_metadata/.test(c.query));
    expect(descCall?.variables).toMatchObject({ col: 'col_stake', value: 'advocacy classification' });
  });

  it('dry-run makes no mutating calls', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
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
    expect(result.summary).toBe('already up to date');
  });
});
