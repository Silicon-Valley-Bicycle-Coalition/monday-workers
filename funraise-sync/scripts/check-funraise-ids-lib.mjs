// Pure helpers for scripts/check-funraise-ids.mjs, split out so they can be unit-tested without
// the network (same pattern as replay-window-lib.mjs).

// The Funraise ID a Donations item carries in its Funraise ID column. The column is a link
// ({ url, text } in the stored value, which is how this Worker and salesforce-import both write
// it); a plain text column is read too, so a fork that maps it differently still works. Returns
// null for a blank cell.
export function extractFunraiseId(columnValue) {
  if (columnValue === null || typeof columnValue !== 'object') return null;
  let id = null;
  if (typeof columnValue.value === 'string' && columnValue.value !== '') {
    try {
      const parsed = JSON.parse(columnValue.value);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') id = parsed.text;
      else if (typeof parsed === 'string') id = parsed;
    } catch {
      // not JSON: fall back to the display text
    }
  }
  if (id === null && typeof columnValue.text === 'string') id = columnValue.text;
  id = id === null ? '' : id.trim();
  return id === '' ? null : id;
}

// Groups the items by Funraise ID. `duplicates` lists every ID carried by more than one item
// (the thing the post-repoint check 3 must find empty); `blank` counts items with no Funraise ID
// (migrated gifts that never came through Funraise, which is normal, reported for context only).
export function findDuplicateFunraiseIds(items, columnId) {
  const byId = new Map();
  let blank = 0;
  for (const item of items) {
    const cell = (item.column_values ?? []).find((c) => c.id === columnId);
    const id = extractFunraiseId(cell);
    if (id === null) {
      blank++;
      continue;
    }
    const ids = byId.get(id) ?? [];
    ids.push(item.id);
    byId.set(id, ids);
  }
  const duplicates = [...byId.entries()]
    .filter(([, itemIds]) => itemIds.length > 1)
    .map(([funraiseId, itemIds]) => ({ funraiseId, itemIds }))
    .sort((a, b) => a.funraiseId.localeCompare(b.funraiseId, 'en', { numeric: true }));
  return { total: items.length, withId: items.length - blank, blank, distinct: byId.size, duplicates };
}
