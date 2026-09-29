import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planBoardBase, planColumnDescriptions, planViews, COLOR_NAMES, type CurrentBoard, type CurrentColumn } from './plan.js';
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
    const { views, notes } = planViews(columns, new Map(), SPEC, 1);
    expect(notes).toEqual([]);
    expect(views.create).toEqual([{ name: 'Active members', filterOperator: 'and',
      rules: [{ column_id: 'col_status', operator: 'any_of', compare_value: [5] }], sort: [], tags: [], settings: undefined, conditionalFormatting: [] }]);
  });

  it('updates a view that already exists, carrying its id', () => {
    const columns: CurrentColumn[] = [
      { id: 'col_status', title: 'Membership Status', type: 'status', description: null,
        settings_str: JSON.stringify({ labels: { '5': 'Active' } }) },
    ];
    const { views } = planViews(columns, new Map([['Active members', 'v1']]), SPEC, 1);
    expect(views.create).toEqual([]);
    expect(views.update[0]!.viewId).toBe('v1');
  });

  it('skips a view whole when a referenced column is missing, with a note', () => {
    const { views, notes } = planViews([], new Map(), SPEC, 1);
    expect(views.create).toEqual([]);
    expect(notes.join(' ')).toMatch(/Active members.*unknown column "Membership Status"/);
  });

  it('emits sort direction as monday’s lowercase enum value, not uppercase', () => {
    const sortSpec: BoardSpec = { ...SPEC, views: [
      { name: 'By date', sort: [{ columnTitle: 'Date', direction: 'desc' }] },
    ] };
    const columns: CurrentColumn[] = [
      { id: 'col_date', title: 'Date', type: 'date', description: null, settings_str: '{}' },
    ];
    const { views } = planViews(columns, new Map(), sortSpec, 1);
    expect(views.create).toEqual([{ name: 'By date', filterOperator: 'and', rules: [],
      sort: [{ column_id: 'col_date', direction: 'desc' }], tags: [], settings: undefined, conditionalFormatting: [] }]);
  });

  it('skips a view whole when a label is unresolvable, with a note', () => {
    const columns: CurrentColumn[] = [
      { id: 'col_status', title: 'Membership Status', type: 'status', description: null,
        settings_str: JSON.stringify({ labels: { '5': 'Something Else' } }) },
    ];
    const { views, notes } = planViews(columns, new Map(), SPEC, 1);
    expect(views.create).toEqual([]);
    expect(notes.join(' ')).toMatch(/unknown label "Active"/);
  });
});

const wire = JSON.parse(readFileSync(new URL('./fixtures/view-wire.json', import.meta.url), 'utf8'));

const COLS: CurrentColumn[] = [
  { id: 'name', title: 'Name', type: 'name', description: null, settings_str: '{}' },
  { id: 'em', title: 'Personal Email', type: 'email', description: null, settings_str: '{}' },
  { id: 'lg', title: 'Lifetime Giving', type: 'numbers', description: null, settings_str: '{}' },
  { id: 'dl', title: 'Donor Level', type: 'status', description: null, settings_str: '{"labels":{"0":"Leadership","1":"Major","2":"Donor"}}' },
  { id: 'dbg', title: 'Salesforce Debug', type: 'long_text', description: null, settings_str: '{}' },
];
const specWith = (views: BoardSpec['views']): BoardSpec => ({ ...SPEC, views });

describe('planViews — settings', () => {
  it('shows exactly the listed columns in order (name first, pinned) and hides the rest', () => {
    const { views } = planViews(COLS, new Map(), specWith([{ name: 'Donors', columns: ['Personal Email', 'Lifetime Giving'] }]), 1);
    expect(views.create[0]!.settings!.columns).toEqual({
      column_order: ['name', 'em', 'lg', 'dl', 'dbg'],
      column_properties: [
        { column_id: 'name', visible: true }, { column_id: 'em', visible: true }, { column_id: 'lg', visible: true },
        { column_id: 'dl', visible: false }, { column_id: 'dbg', visible: false },
      ],
      floating_columns_count: 1,
    });
  });

  it('resolves group-by to a column id with Monday-case direction', () => {
    const { views } = planViews(COLS, new Map(), specWith([{ name: 'Donors', groupBy: { columnTitle: 'Donor Level', direction: 'desc' } }]), 1);
    expect(views.create[0]!.settings!.group_by).toEqual({
      conditions: [{ columnId: 'dl', config: { sortSettings: { direction: 'DESC' } } }], hideEmptyGroups: true });
  });

  it('carries the tag', () => {
    const { views } = planViews(COLS, new Map(), specWith([{ name: 'Donors', tag: 'Report' }]), 1);
    expect(views.create[0]!.tags).toEqual(['Report']);
  });

  const keyShape = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, k === 'context' || k === 'formatting' || k === 'target' || k === 'rule' || k === 'rules' ? keyShape((v as Record<string, unknown>)[k]) : null]))
      : Array.isArray(v) ? v.map(keyShape) : null;

  it('builds a conditional-formatting rule in the captured wire shape', () => {
    const mk = () => planViews(COLS, new Map(), specWith([{ name: 'Donors',
      coloring: [{ columnTitle: 'Donor Level', labelValues: ['Major'], color: 'red' }] }]), 1).views.create[0]!.conditionalFormatting[0] as Record<string, any>;
    const rule = mk();
    expect(keyShape(rule)).toEqual(keyShape(wire.conditionalFormatting));
    expect(rule.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mk().id).not.toBe(rule.id);
    expect(rule.formatting.highlight_color).toEqual([COLOR_NAMES.red]);
    expect(rule.target).toEqual({ column_ids: [], entire_row: true });
    expect(rule.rules[0]).toEqual({ type: 'RULE', operator: 'ANY_OF', rule: {
      type: 'BOARD_COLUMN',
      context: { column_id: 'dl', column_type: 'color', compare_attribute: '', board_id: '1' },
      compare_value: [1] } });
  });

  it('targets just the column and maps numbers to numeric when entireRow is false', () => {
    const { views } = planViews(COLS, new Map(), specWith([{ name: 'Donors',
      coloring: [{ columnTitle: 'Lifetime Giving', operator: 'greater_than', compareValue: 100, color: 'green', entireRow: false }] }]), 7);
    const rule = views.create[0]!.conditionalFormatting[0] as Record<string, any>;
    expect(rule.target).toEqual({ column_ids: ['lg'], entire_row: false });
    expect(rule.rules[0].operator).toBe('GREATER_THAN');
    expect(rule.rules[0].rule.context).toMatchObject({ column_type: 'numeric', board_id: '7' });
    expect(rule.rules[0].rule.compare_value).toBe(100);
  });

  it('accepts a relative-date coloring operator', () => {
    const cols: CurrentColumn[] = [...COLS, { id: 'dt', title: 'Due', type: 'date', description: null, settings_str: '{}' }];
    const { views } = planViews(cols, new Map(), specWith([{ name: 'Soon',
      coloring: [{ columnTitle: 'Due', operator: 'within_the_next', compareValue: ['DAYS', 60], color: 'amber' }] }]), 1);
    const rule = views.create[0]!.conditionalFormatting[0] as Record<string, any>;
    expect(rule.rules[0].operator).toBe('WITHIN_THE_NEXT');
    expect(rule.rules[0].rule.context.column_type).toBe('date');
    expect(rule.rules[0].rule.compare_value).toEqual(['DAYS', 60]);
  });

  it('skips the whole view when a listed column does not exist yet', () => {
    const { views, notes } = planViews(COLS, new Map(), specWith([{ name: 'Donors', columns: ['Personal Email', 'Gift Size'] }]), 1);
    expect(views.create).toHaveLength(0);
    expect(notes[0]).toMatch(/Donors.*unknown column "Gift Size"/);
  });

  it('skips the whole view when a colouring label does not exist', () => {
    const { views } = planViews(COLS, new Map(), specWith([{ name: 'Donors', coloring: [{ columnTitle: 'Donor Level', labelValues: ['Platinum'], color: 'red' }] }]), 1);
    expect(views.create).toHaveLength(0);
  });
});
