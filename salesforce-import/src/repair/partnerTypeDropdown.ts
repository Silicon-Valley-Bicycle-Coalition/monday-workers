// Moves the loaded Organizations boards from the free-text Partner Type to the dropdown (GL#55). Monday
// can't change a column's type (update_column's column_type "must match the existing column type"),
// so this is a new column filled from the old one. Used once per board, by
// scripts/relabel-partner-type.ts.
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';
import { partnerTypeFor, type PartnerType } from '../transform/partnerType.js';

export const LIVE_TITLE = 'Partner Type';
export const BUILDING_TITLE = 'Partner Type (dropdown)';
export const RETIRED_TITLE = 'Partner Type (old text)';

export interface RelabelColumn { id: string; title: string; type: string }

/** Finds both columns at any point in the run: before the dropdown exists, mid-run, or after the swap. */
export function findPartnerTypeColumns<C extends RelabelColumn>(columns: C[]): { source?: C; target?: C } {
  const find = (type: string, titles: string[]) =>
    columns.find((c) => c.type === type && titles.includes(bareTitle(c.title)));
  return { source: find('text', [LIVE_TITLE, RETIRED_TITLE]), target: find('dropdown', [LIVE_TITLE, BUILDING_TITLE]) };
}

export interface RelabelRow { id: string; name: string; source: string; current: string }
export interface RelabelPlan {
  write: (RelabelRow & { label: PartnerType })[];
  alreadySet: number;
  blank: number;
  unmapped: RelabelRow[];
  bySource: { source: string; label: PartnerType; count: number }[];
}

export function planRelabel(rows: RelabelRow[]): RelabelPlan {
  const plan: RelabelPlan = { write: [], alreadySet: 0, blank: 0, unmapped: [], bySource: [] };
  const tally = new Map<string, { source: string; label: PartnerType; count: number }>();
  for (const row of rows) {
    const label = partnerTypeFor(row.source);
    if (label === undefined) { plan.unmapped.push(row); continue; }
    if (label === '') { plan.blank += 1; continue; }
    const entry = tally.get(row.source) ?? { source: row.source, label, count: 0 };
    entry.count += 1;
    tally.set(row.source, entry);
    // A set dropdown is either this script's earlier write or a staff edit after the swap.
    if (row.current) plan.alreadySet += 1;
    else plan.write.push({ ...row, label });
  }
  plan.bySource = [...tally.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  return plan;
}
