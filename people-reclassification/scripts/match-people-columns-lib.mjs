// What match-people-columns.mjs has to create. The gap itself comes from the Worker's own column
// check (moveMapping), so this can't disagree with what stops a pass.

import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { moveMapping } from '../src/columns.ts';

// Types create_column makes whole from a title. Anything else is left to a person: a connect column
// needs its boards chosen, dropdown label ids can't be chosen, and Monday can't create a doc column.
const PLAIN_TYPES = new Set(['checkbox', 'date', 'email', 'link', 'location', 'long_text', 'numbers', 'phone', 'text']);

const labelsOf = (column) => Object.fromEntries(
  Object.entries(JSON.parse(column.settings_str || '{}').labels ?? {}).filter(([, text]) => text !== ''),
);

// live and historical: { id, columns: [{ id, title, type, settings_str }] }.
export function planMatch(live, historical) {
  const create = [];
  const byHand = [];
  for (const [source, target] of [[live, historical], [historical, live]]) {
    const { missing } = moveMapping(source.columns, target.columns);
    for (const { title, type } of missing) {
      const column = source.columns.find((c) => c.title === title && c.type === type);
      const entry = { boardId: target.id, title, type };
      if (target.columns.some((c) => bareTitle(c.title) === bareTitle(title))) {
        byHand.push({ ...entry, why: 'the board already has that title with another type' });
      } else if (PLAIN_TYPES.has(type)) {
        create.push({ ...entry, defaults: null });
      } else if (type === 'status') {
        // Monday shows label id 5's text for an empty cell, so never copy one there.
        const labels = labelsOf(column);
        if ('5' in labels) byHand.push({ ...entry, why: 'it has a label at id 5; move that label first' });
        else create.push({ ...entry, defaults: { labels } });
      } else {
        byHand.push({ ...entry, why: `a ${type} column needs settings this script can't copy` });
      }
    }
  }
  return { create, byHand };
}

// Titles of the created status columns whose labels aren't at the ids asked for.
export function labelMismatches(created, boards) {
  const key = (labels) => JSON.stringify(Object.entries(labels).sort());
  return created.filter((c) => {
    if (c.type !== 'status') return false;
    const column = boards.find((b) => b.id === c.boardId)?.columns.find((x) => x.title === c.title && x.type === 'status');
    return column === undefined || key(labelsOf(column)) !== key(c.defaults.labels);
  }).map((c) => c.title);
}
