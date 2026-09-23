import type { MondayClient } from './monday.js';

// Every imported item carries its Salesforce Id in this plain-text column, so the loader can
// find an item Monday created but the ledger never recorded (a lost create_item response, or a
// crash between the create and the ledger append) instead of creating it a second time.
// 'Salesforce Debug' can't serve: long_text isn't searchable by items_page_by_column_values.
export const SF_ID_COLUMN = 'Salesforce ID';

const PAGE = 500;

interface ItemsPage { cursor: string | null; items: { id: string; column_values: { text: string | null }[] }[] }

// Every ACTIVE item on the board, grouped by its Salesforce ID column value (items_page can't
// see archived items — those were ledgered before archive, so they never need adopting).
// Items with no value (created before the column existed, or added by staff) are counted
// separately rather than dropped.
export async function scanBoardSfIds(client: MondayClient, boardId: number, colId: string):
  Promise<{ bySfId: Map<string, string[]>; untagged: number; total: number }> {
  const bySfId = new Map<string, string[]>();
  let untagged = 0, total = 0;
  const take = (page: ItemsPage | undefined) => {
    for (const item of page?.items ?? []) {
      total++;
      const sfId = item.column_values[0]?.text?.trim();
      if (!sfId) { untagged++; continue; }
      if (!bySfId.has(sfId)) bySfId.set(sfId, []);
      bySfId.get(sfId)!.push(item.id);
    }
    return page?.cursor ?? null;
  };
  const first = await client.gql<{ boards: { items_page?: ItemsPage }[] }>(
    `query ($ids: [ID!], $col: [String!], $limit: Int!) { boards (ids: $ids) {
       items_page (limit: $limit) { cursor items { id column_values (ids: $col) { text } } } } }`,
    { ids: [String(boardId)], col: [colId], limit: PAGE });
  let cursor = take(first.boards[0]?.items_page);
  while (cursor) {
    const next = await client.gql<{ next_items_page: ItemsPage }>(
      `query ($cursor: String!, $col: [String!], $limit: Int!) { next_items_page (cursor: $cursor, limit: $limit) {
         cursor items { id column_values (ids: $col) { text } } } }`,
      { cursor, col: [colId], limit: PAGE });
    cursor = take(next.next_items_page);
  }
  return { bySfId, untagged, total };
}

export async function findItemIdsBySfId(client: MondayClient, boardId: number, colId: string,
  sfId: string): Promise<string[]> {
  const res = await client.gql<{ items_page_by_column_values: { items: { id: string }[] } }>(
    `query ($board: ID!, $col: String!, $val: String!) {
       items_page_by_column_values (board_id: $board, limit: 5,
         columns: [{ column_id: $col, column_values: [$val] }]) { items { id } } }`,
    { board: String(boardId), col: colId, val: sfId });
  return res.items_page_by_column_values.items.map((i) => i.id);
}
