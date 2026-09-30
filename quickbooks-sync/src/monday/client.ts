import { MondayGraphQL, type MondayGraphQLOptions } from './graphql';

export interface MondayItem {
  id: string;
}

// An item as it stands now. `value` is Monday's raw JSON-encoded column value (null when empty),
// `text` its display text. `state` matters: items(ids:) also returns archived and deleted items
// (API 2026-01), so callers must check for 'active'.
export interface MondayItemSnapshot {
  id: string;
  name: string;
  state: 'active' | 'archived' | 'deleted' | string;
  columnValues: Record<string, { text: string | null; value: string | null }>;
}

export interface MondayClient {
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  // null when the item doesn't exist (deleted, or never did).
  getItem(itemId: string): Promise<MondayItemSnapshot | null>;
  findItemIdsByColumnValue(boardId: number, columnId: string, value: string): Promise<string[]>;
}

// The queries below (and the `state` handling above) were written and verified against 2026-01;
// the canonical transport's default is newer, so pin this Worker's version explicitly until
// they're re-checked.
const MONDAY_API_VERSION = '2026-01';

// Queue-consumer tuning (#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget; anything longer fails the message, and the consumer's own
// backoff (1, 4, 16 minutes — consumer/processBatch.ts) takes over rather than holding a batch.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 20_000, apiVersion: MONDAY_API_VERSION };

export class HttpMondayClient implements MondayClient {
  private readonly transport: MondayGraphQL;

  constructor(apiUrl: string, apiToken: string, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options });
  }

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem> {
    // Not idempotent: a create that may have committed (5xx, timeout) throws AmbiguousWriteError
    // instead of retrying in-process; the consumer's pending_monday_item_id / QuickBooks Id
    // guards find and adopt the item on the next delivery if the first create did land.
    const data = await this.transport.request<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues) },
      { idempotent: false }
    );
    return data.create_item;
  }

  async getItem(itemId: string): Promise<MondayItemSnapshot | null> {
    const data = await this.transport.request<{
      items: { id: string; name: string; state: string; column_values: { id: string; text: string | null; value: string | null }[] }[];
    }>(
      `query ($ids: [ID!]) {
        items(ids: $ids) {
          id
          name
          state
          column_values { id text value }
        }
      }`,
      { ids: [itemId] }
    );
    const item = data.items[0];
    if (item === undefined) return null;
    return {
      id: item.id,
      name: item.name,
      state: item.state,
      columnValues: Object.fromEntries(item.column_values.map((c) => [c.id, { text: c.text, value: c.value }])),
    };
  }

  async findItemIdsByColumnValue(boardId: number, columnId: string, value: string): Promise<string[]> {
    const data = await this.transport.request<{ items_page_by_column_values: { items: { id: string }[] } }>(
      `query ($boardId: ID!, $columnId: String!, $value: String!) {
        items_page_by_column_values(limit: 5, board_id: $boardId, columns: [{ column_id: $columnId, column_values: [$value] }]) {
          items { id }
        }
      }`,
      { boardId, columnId, value }
    );
    return data.items_page_by_column_values.items.map((item) => item.id);
  }

  async changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void> {
    await this.transport.request<{ change_multiple_column_values: MondayItem }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues) }
    );
  }
}
