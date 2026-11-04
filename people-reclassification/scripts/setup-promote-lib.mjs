import { bareTitle } from '../../scripts/lib/column-titles.mjs';

// What setup-promote.mjs still has to create. Titles compare through bareTitle, so a column already
// carrying its read-only marker isn't created again. A webhook counts only if it watches this
// board's status column, not merely if it has the same event.
export function planPromoteSetup(boards, statusColumnTitle, dateColumnTitle, { webhooks = true } = {}) {
  const createColumns = [];
  const createWebhooks = [];
  for (const board of boards) {
    const find = (title) => board.columns.find((c) => bareTitle(c.title) === bareTitle(title));
    for (const [title, type] of [[statusColumnTitle, 'status'], [dateColumnTitle, 'date']]) {
      if (find(title) === undefined) createColumns.push({ boardId: board.id, title, type });
    }
    const columnId = find(statusColumnTitle)?.id;
    const subscribed = board.webhooks.some((w) => w.event === 'change_specific_column_value'
      && columnId !== undefined && JSON.parse(w.config ?? '{}').columnId === columnId);
    if (webhooks && !subscribed) createWebhooks.push(board.id);
  }
  return { createColumns, createWebhooks };
}
