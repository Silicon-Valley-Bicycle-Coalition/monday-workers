import type { BoardSpec, ColumnSpec, ViewSpec } from './spec.js';
import { resolveLabelId } from './labels.js';

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

  const existingTitles = new Set(current.columns.map((c) => c.title));
  const columnsToCreate = (spec.columns ?? []).filter((c) => !existingTitles.has(c.title));

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
  const byTitle = new Map(columns.map((c) => [c.title, c]));
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
export interface ResolvedView { name: string; filterOperator: 'and' | 'or'; rules: ResolvedRule[]; sort: { column_id: string; direction: string }[] }

// Views reference columns by title, resolved against the board's *current* column set — call
// this after columnsToCreate has actually been applied, so newly-added columns are eligible
// targets too. A view with any unresolvable column reference is skipped whole (not partially
// built) so a saved view never silently loses part of its intended filter.
export function planViews(
  columns: CurrentColumn[], existingViewNames: Set<string>, spec: BoardSpec,
): { views: ResolvedView[]; notes: string[] } {
  const notes: string[] = [];
  const views: ResolvedView[] = [];
  const byTitle = new Map(columns.map((c) => [c.title, c]));

  for (const viewSpec of spec.views ?? []) {
    if (existingViewNames.has(viewSpec.name)) continue;
    const resolved = resolveView(viewSpec, byTitle);
    if ('error' in resolved) { notes.push(`view "${viewSpec.name}" skipped — ${resolved.error}`); continue; }
    views.push(resolved.view);
  }
  return { views, notes };
}

function resolveView(
  viewSpec: ViewSpec, byTitle: Map<string, CurrentColumn>,
): { view: ResolvedView } | { error: string } {
  const rules: ResolvedRule[] = [];
  for (const rule of viewSpec.filter?.rules ?? []) {
    const col = byTitle.get(rule.columnTitle);
    if (!col) return { error: `filter references unknown column "${rule.columnTitle}"` };
    let compare_value: unknown = rule.compareValue ?? [];
    if (rule.labelValues) {
      const ids: number[] = [];
      for (const label of rule.labelValues) {
        const id = resolveLabelId(col.type, col.settings_str, label);
        if (id === undefined) return { error: `filter on "${rule.columnTitle}" — unknown label "${label}"` };
        ids.push(id);
      }
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

  return { view: { name: viewSpec.name, filterOperator: viewSpec.filter?.operator ?? 'and', rules, sort } };
}
