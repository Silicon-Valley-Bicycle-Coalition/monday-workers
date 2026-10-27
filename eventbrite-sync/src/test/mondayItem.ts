import type { MondayItemColumns } from '../monday/client';

// A getItems result as Monday returns it: a cell with text has a stored value (a status cell's
// carries its label index), a blank cell's value is null. Pass `values` to override a column's
// raw value — e.g. null with non-blank text, which is how Monday reports an EMPTY status cell
// whose label id 5 (the empty-cell default) is a real label.
export function mondayItem(
  id: string,
  name: string,
  columns: Record<string, string>,
  opts: { state?: string; values?: Record<string, string | null> } = {}
): MondayItemColumns {
  const values = Object.fromEntries(
    Object.entries(columns).map(([c, text]) => [c, text.trim() === '' ? null : JSON.stringify({ index: 1, text })])
  );
  return { id, name, state: opts.state ?? 'active', columns, values: { ...values, ...opts.values } };
}
