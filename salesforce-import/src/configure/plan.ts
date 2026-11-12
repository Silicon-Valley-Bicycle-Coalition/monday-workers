import { createHash } from 'node:crypto';
import type { BoardSpec, ColoringRule, ColumnSpec, ViewSpec } from './spec.js';
import { resolveLabelId } from './labels.js';
import { fiscalYearRange, isFiscalYearValue } from './fiscal.js';
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';

export interface CurrentColumn { id: string; title: string; type: string; description: string | null; settings_str: string }
export interface CurrentGroup { id: string; title: string }
export interface CurrentView { id: string; name: string }
export interface CurrentBoard { description: string | null; groups: CurrentGroup[]; columns: CurrentColumn[]; views: CurrentView[] }

export interface BasePlan {
  description?: string;
  groupRename?: { groupId: string; newTitle: string };
  columnsToCreate: ColumnSpec[];
  viewsToDelete: { viewId: string; name: string }[];
  notes: string[];
}

// Board-level description, default-group rename, additive columns, and stray-view cleanup.
// Non-destructive: an already-populated description or an already-split-into-groups board is
// left alone (noted, not overwritten) rather than assumed wrong.
export function planBoardBase(current: CurrentBoard, spec: BoardSpec): BasePlan {
  const notes: string[] = [];

  let description: string | undefined;
  if (!current.description || !current.description.trim()) description = spec.description;
  else if (current.description !== spec.description) notes.push('description already set (left as-is, differs from spec)');

  let groupRename: BasePlan['groupRename'];
  if (current.groups.length === 1) {
    if (current.groups[0]!.title !== spec.groupTitle) {
      groupRename = { groupId: current.groups[0]!.id, newTitle: spec.groupTitle };
    }
  } else if (current.groups.length > 1) {
    notes.push(`board already has ${current.groups.length} groups — skipping default-group rename`);
  }

  const existingTitles = new Set(current.columns.map((c) => bareTitle(c.title)));
  const columnsToCreate = (spec.columns ?? []).filter((c) => !existingTitles.has(bareTitle(c.title)));

  const strayNames = new Set(spec.deleteStrayViews ?? []);
  const viewsToDelete = current.views
    .filter((v) => strayNames.has(v.name))
    .map((v) => ({ viewId: v.id, name: v.name }));

  return { description, groupRename, columnsToCreate, viewsToDelete, notes };
}

export interface ColumnDescriptionUpdate { columnId: string; title: string; text: string }

// Only fills a blank description — an already-written one (even a differing one) is treated as
// a deliberate edit and left alone, same policy as the board description above.
export function planColumnDescriptions(
  columns: CurrentColumn[], spec: BoardSpec,
): { updates: ColumnDescriptionUpdate[]; notes: string[] } {
  const updates: ColumnDescriptionUpdate[] = [];
  const notes: string[] = [];
  const byTitle = new Map(columns.map((c) => [bareTitle(c.title), c]));
  for (const [title, text] of Object.entries(spec.columnDescriptions ?? {})) {
    const col = byTitle.get(title);
    if (!col) { notes.push(`column description for "${title}" — no such column on this board yet`); continue; }
    if (col.description && col.description.trim()) {
      if (col.description !== text) notes.push(`column "${title}" already has a description — left as-is`);
      continue;
    }
    updates.push({ columnId: col.id, title, text });
  }
  return { updates, notes };
}

export interface ResolvedRule { column_id: string; operator: string; compare_value: unknown }

export const COLOR_NAMES: Record<ColoringRule['color'], string> = {
  red: 'stuck-red', amber: 'orange', green: 'done-green', grey: 'blackish',
};

export interface ResolvedView {
  name: string;
  filterOperator: 'and' | 'or';
  rules: ResolvedRule[];
  sort: { column_id: string; direction: string }[];
  tags: string[];
  settings?: {
    columns?: { column_order: string[]; column_properties: { column_id: string; visible: boolean }[]; floating_columns_count: number };
    group_by?: { conditions: { columnId: string; config: { sortSettings: { direction: 'ASC' | 'DESC' } } }[]; hideEmptyGroups: boolean };
  };
  conditionalFormatting: unknown[];
}

// The API's column type -> the type conditional formatting uses internally.
const INTERNAL_TYPE: Record<string, string> = { status: 'color', numbers: 'numeric' };

// Shape captured from an API-accepted call (fixtures/view-wire.json).
// Deterministic rule id (UUID-shaped, version 5 nibble) so re-applying a view doesn't churn ids.
export function stableRuleId(boardId: number, viewName: string, ruleIndex: number): string {
  const h = createHash('sha1').update(`${boardId}\u0000${viewName}\u0000${ruleIndex}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function toWireCondition(
  boardId: number, col: CurrentColumn, operator: string, compare: unknown, color: string, entireRow: boolean, id: string,
): unknown {
  return {
    id,
    formatting: { highlight_color: [color] },
    target: { column_ids: entireRow ? [] : [col.id], entire_row: entireRow },
    rules: [{
      type: 'RULE',
      operator: operator.toUpperCase(),
      rule: {
        type: 'BOARD_COLUMN',
        context: { column_id: col.id, column_type: INTERNAL_TYPE[col.type] ?? col.type, compare_attribute: '', board_id: String(boardId) },
        compare_value: compare,
      },
    }],
  };
}

// Views reference columns by title, resolved against the board's *current* column set — call
// this after columnsToCreate has been applied. A view with any unresolvable reference is
// skipped whole so a saved view never silently loses part of its filter, columns, or colour.
// Spec views are created when absent and re-applied (updated) when present; views whose names
// aren't in the spec — ones staff made — are never touched.
export function planViews(
  columns: CurrentColumn[], existingViews: Map<string, string>, spec: BoardSpec, boardId: number, now: Date = new Date(),
): { views: { create: ResolvedView[]; update: (ResolvedView & { viewId: string })[] }; notes: string[] } {
  const notes: string[] = [];
  const create: ResolvedView[] = [];
  const update: (ResolvedView & { viewId: string })[] = [];
  const byTitle = new Map(columns.map((c) => [bareTitle(c.title), c]));

  for (const viewSpec of spec.views ?? []) {
    const resolved = resolveView(viewSpec, byTitle, columns, boardId, now);
    if ('error' in resolved) { notes.push(`view "${viewSpec.name}" skipped — ${resolved.error}`); continue; }
    const viewId = existingViews.get(viewSpec.name);
    if (viewId) update.push({ ...resolved.view, viewId });
    else create.push(resolved.view);
  }
  return { views: { create, update }, notes };
}

function resolveLabels(col: CurrentColumn, labels: string[]): number[] | string {
  const ids: number[] = [];
  for (const label of labels) {
    const id = resolveLabelId(col.type, col.settings_str, label);
    if (id === undefined) return label;
    ids.push(id);
  }
  return ids;
}

function resolveView(
  viewSpec: ViewSpec, byTitle: Map<string, CurrentColumn>, allColumns: CurrentColumn[], boardId: number, now: Date,
): { view: ResolvedView } | { error: string } {
  const rules: ResolvedRule[] = [];
  for (const rule of viewSpec.filter?.rules ?? []) {
    const col = byTitle.get(rule.columnTitle);
    if (!col) return { error: `filter references unknown column "${rule.columnTitle}"` };
    let compare_value: unknown = rule.compareValue ?? [];
    // { fiscalYear } is resolved from the clock; re-running configure each July refreshes it.
    if (isFiscalYearValue(compare_value)) compare_value = fiscalYearRange(now, compare_value.fiscalYear === 'previous' ? -1 : 0);
    if (rule.labelValues) {
      const ids = resolveLabels(col, rule.labelValues);
      if (typeof ids === 'string') return { error: `filter on "${rule.columnTitle}" — unknown label "${ids}"` };
      compare_value = ids;
    }
    rules.push({ column_id: col.id, operator: rule.operator, compare_value });
  }

  const sort: ResolvedView['sort'] = [];
  for (const s of viewSpec.sort ?? []) {
    const col = byTitle.get(s.columnTitle);
    if (!col) return { error: `sort references unknown column "${s.columnTitle}"` };
    sort.push({ column_id: col.id, direction: s.direction ?? 'asc' });
  }

  let settings: ResolvedView['settings'];
  if (viewSpec.columns) {
    const visible = ['name'];
    for (const title of viewSpec.columns) {
      const col = byTitle.get(title);
      if (!col) return { error: `unknown column "${title}"` };
      if (!visible.includes(col.id)) visible.push(col.id);
    }
    const hidden = allColumns.map((c) => c.id).filter((id) => !visible.includes(id));
    settings = { columns: {
      column_order: [...visible, ...hidden],
      column_properties: [
        ...visible.map((id) => ({ column_id: id, visible: true })),
        ...hidden.map((id) => ({ column_id: id, visible: false })),
      ],
      floating_columns_count: 1,
    } };
  }
  if (viewSpec.groupBy) {
    const col = byTitle.get(viewSpec.groupBy.columnTitle);
    if (!col) return { error: `groupBy references unknown column "${viewSpec.groupBy.columnTitle}"` };
    settings = { ...settings, group_by: {
      conditions: [{ columnId: col.id, config: { sortSettings: { direction: viewSpec.groupBy.direction === 'desc' ? 'DESC' : 'ASC' } } }],
      hideEmptyGroups: true,
    } };
  }

  const conditionalFormatting: unknown[] = [];
  for (const [ruleIndex, rule] of (viewSpec.coloring ?? []).entries()) {
    const col = byTitle.get(rule.columnTitle);
    if (!col) return { error: `coloring references unknown column "${rule.columnTitle}"` };
    let compare: unknown = rule.compareValue ?? [];
    if (rule.labelValues) {
      const ids = resolveLabels(col, rule.labelValues);
      if (typeof ids === 'string') return { error: `coloring on "${rule.columnTitle}" — unknown label "${ids}"` };
      compare = ids;
    }
    conditionalFormatting.push(toWireCondition(boardId, col, rule.operator ?? 'any_of', compare, COLOR_NAMES[rule.color], rule.entireRow ?? true,
      stableRuleId(boardId, viewSpec.name, ruleIndex)));
  }

  return { view: { name: viewSpec.name, filterOperator: viewSpec.filter?.operator ?? 'and', rules, sort,
    tags: viewSpec.tag ? [viewSpec.tag] : [], settings, conditionalFormatting } };
}
