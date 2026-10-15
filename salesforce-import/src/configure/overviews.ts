import { widgetFilter, widgetSettings, type Columns, type WidgetSpec } from './widgets.js';

export const OVERVIEW_NAME = 'Overview';

export interface OverviewSpec { widgets: WidgetSpec[] }
export interface PlannedWidget { name: string; kind: WidgetSpec['kind']; settings: unknown; filter?: unknown }
export type OverviewPlan = { ok: true; widgets: PlannedWidget[] } | { ok: false; errors: string[] };

const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v;

// An Overview is created whole or not at all: widgets added to a board-view dashboard after it has
// been opened do not render, so a half-resolvable spec must not produce a half-built view.
export function planOverview(spec: OverviewSpec, columns: Columns): OverviewPlan {
  const widgets: PlannedWidget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const w of spec.widgets) {
    if (seen.has(w.name)) { errors.push(`duplicate widget name "${w.name}"`); continue; }
    seen.add(w.name);
    const settings = widgetSettings(w, columns);
    if (isError(settings)) { errors.push(`widget "${w.name}": ${settings.error}`); continue; }
    const filter = widgetFilter(w, columns);
    if (isError(filter)) { errors.push(`widget "${w.name}": ${filter.error}`); continue; }
    widgets.push({ name: w.name, kind: w.kind, settings, ...(filter ? { filter } : {}) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, widgets };
}
