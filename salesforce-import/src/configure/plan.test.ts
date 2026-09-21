import { describe, it, expect } from 'vitest';
import { planBoardBase, planColumnDescriptions, planViews, type CurrentBoard, type CurrentColumn } from './plan.js';
import type { BoardSpec } from './spec.js';

const SPEC: BoardSpec = {
  description: 'The real description.',
  groupTitle: 'People',
  columns: [{ title: 'Stakeholder Type', type: 'status', labels: ['Individual Donor', 'Elected Official'] }],
  columnDescriptions: { 'Personal Email': 'own address', 'Stakeholder Type': 'advocacy classification' },
  views: [
    { name: 'Active members', filter: { rules: [{ columnTitle: 'Membership Status', operator: 'any_of', labelValues: ['Active'] }] } },
  ],
  deleteStrayViews: ['Build Vibe view'],
};

describe('planBoardBase', () => {
  it('proposes the spec description when the board has none', () => {
    const current: CurrentBoard = { description: null, groups: [{ id: 'g1', title: 'Group Title' }], columns: [], views: [] };
    const plan = planBoardBase(current, SPEC);
    expect(plan.description).toBe('The real description.');
  });

  it('leaves an already-populated description alone and notes the mismatch', () => {
    const current: CurrentBoard = { description: 'Someone wrote their own.', groups: [], columns: [], views: [] };
    const plan = planBoardBase(current, SPEC);
    expect(plan.description).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/description already set/);
  });

  it('renames the single default group to the spec title', () => {
    const current: CurrentBoard = { description: null, groups: [{ id: 'g1', title: 'Group Title' }], columns: [], views: [] };
    const plan = planBoardBase(current, SPEC);
    expect(plan.groupRename).toEqual({ groupId: 'g1', newTitle: 'People' });
  });

  it('skips the group rename once already correct, and when multiple groups exist', () => {
    const already: CurrentBoard = { description: null, groups: [{ id: 'g1', title: 'People' }], columns: [], views: [] };
    expect(planBoardBase(already, SPEC).groupRename).toBeUndefined();

    const split: CurrentBoard = { description: null, groups: [{ id: 'g1', title: 'A' }, { id: 'g2', title: 'B' }], columns: [], views: [] };
    const plan = planBoardBase(split, SPEC);
    expect(plan.groupRename).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/already has 2 groups/);
  });

  it('only proposes columns that do not already exist', () => {
    const current: CurrentBoard = { description: null, groups: [], columns: [
      { id: 'c1', title: 'Stakeholder Type', type: 'status', description: null, settings_str: '{}' },
    ], views: [] };
    expect(planBoardBase(current, SPEC).columnsToCreate).toEqual([]);
  });

  it('finds stray views to delete by name', () => {
    const current: CurrentBoard = { description: null, groups: [], columns: [], views: [{ id: 'v1', name: 'Build Vibe view' }, { id: 'v2', name: 'Keep me' }] };
    expect(planBoardBase(current, SPEC).viewsToDelete).toEqual([{ viewId: 'v1', name: 'Build Vibe view' }]);
  });
});

describe('planColumnDescriptions', () => {
  it('sets a blank description and skips a column missing from the board', () => {
    const columns: CurrentColumn[] = [
      { id: 'c1', title: 'Personal Email', type: 'email', description: null, settings_str: '{}' },
    ];
    const { updates, notes } = planColumnDescriptions(columns, SPEC);
    expect(updates).toEqual([{ columnId: 'c1', title: 'Personal Email', text: 'own address' }]);
    expect(notes.join(' ')).toMatch(/Stakeholder Type.*no such column/);
  });

  it('leaves an already-described column alone', () => {
    const columns: CurrentColumn[] = [
      { id: 'c1', title: 'Personal Email', type: 'email', description: 'someone wrote this', settings_str: '{}' },
    ];
    const { updates, notes } = planColumnDescriptions(columns, SPEC);
    expect(updates).toEqual([]);
    expect(notes.join(' ')).toMatch(/already has a description/);
  });
});

describe('planViews', () => {
  it('resolves a status filter to the column’s actual label id', () => {
    const columns: CurrentColumn[] = [
      { id: 'col_status', title: 'Membership Status', type: 'status', description: null,
        settings_str: JSON.stringify({ labels: { '5': 'Active', '9': 'Lapsed' } }) },
    ];
    const { views, notes } = planViews(columns, new Set(), SPEC);
    expect(notes).toEqual([]);
    expect(views).toEqual([{ name: 'Active members', filterOperator: 'and',
      rules: [{ column_id: 'col_status', operator: 'any_of', compare_value: [5] }], sort: [] }]);
  });

  it('skips a view that already exists', () => {
    const columns: CurrentColumn[] = [
      { id: 'col_status', title: 'Membership Status', type: 'status', description: null,
        settings_str: JSON.stringify({ labels: { '5': 'Active' } }) },
    ];
    const { views } = planViews(columns, new Set(['Active members']), SPEC);
    expect(views).toEqual([]);
  });

  it('skips a view whole when a referenced column is missing, with a note', () => {
    const { views, notes } = planViews([], new Set(), SPEC);
    expect(views).toEqual([]);
    expect(notes.join(' ')).toMatch(/Active members.*unknown column "Membership Status"/);
  });

  it('emits sort direction as monday’s lowercase enum value, not uppercase', () => {
    const sortSpec: BoardSpec = { ...SPEC, views: [
      { name: 'By date', sort: [{ columnTitle: 'Date', direction: 'desc' }] },
    ] };
    const columns: CurrentColumn[] = [
      { id: 'col_date', title: 'Date', type: 'date', description: null, settings_str: '{}' },
    ];
    const { views } = planViews(columns, new Set(), sortSpec);
    expect(views).toEqual([{ name: 'By date', filterOperator: 'and', rules: [],
      sort: [{ column_id: 'col_date', direction: 'desc' }] }]);
  });

  it('skips a view whole when a label is unresolvable, with a note', () => {
    const columns: CurrentColumn[] = [
      { id: 'col_status', title: 'Membership Status', type: 'status', description: null,
        settings_str: JSON.stringify({ labels: { '5': 'Something Else' } }) },
    ];
    const { views, notes } = planViews(columns, new Set(), SPEC);
    expect(views).toEqual([]);
    expect(notes.join(' ')).toMatch(/unknown label "Active"/);
  });
});
