import { MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export interface MondayItem {
  id: string;
}

export interface MondayClient {
  findItemByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem | null>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  // Item names, state, and the `text` (blank -> '') and raw stored `value` (JSON string, or null when
  // the cell is empty) of the requested columns. Read a status column with statusText, never its
  // text: Monday shows label id 5's text for an EMPTY status cell. items(ids:) also
  // returns archived and deleted items, so callers must check `state === 'active'` (isActive) rather
  // than treat an omitted id as the only way an item can be gone; an id Monday has purged is omitted.
  getItems(boardId: number, itemIds: string[], columnIds: string[]): Promise<MondayItemColumns[]>;
  // Bell notification to a user about an item (create_notification, target_type Project).
  notify(userId: number, itemId: string, text: string): Promise<void>;
}

export interface MondayItemColumns {
  id: string;
  name: string;
  // Monday's item state: 'active', 'archived' or 'deleted'.
  state: string;
  // Each requested column's text — for text-like columns (email, names, link text).
  columns: Record<string, string>;
  // Each requested column's raw stored value: a JSON string, or null for an empty cell.
  values: Record<string, string | null>;
}

// A status cell's label, or '' when the cell is empty. Monday's `text` for an EMPTY status cell is
// label id 5's text (its empty-cell default), so a real label at id 5 makes every blank cell read
// as labelled; only the stored value tells them apart — null, or no numeric label index, is blank.
export function statusText(item: MondayItemColumns, columnId: string): string {
  const raw = item.values[columnId];
  if (raw === null || raw === undefined || raw.trim() === '') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { index?: unknown }).index !== 'number') return '';
  return (item.columns[columnId] ?? '').trim();
}

export function isActive(item: MondayItemColumns | undefined): item is MondayItemColumns {
  return item !== undefined && item.state === 'active';
}

// items(ids:) accepts at most 100 ids per call.
const ITEMS_BATCH_SIZE = 100;

// API-Version comes from the transport's single pin (MONDAY_API_VERSION in graphql.ts, #39).
// Queue-consumer tuning (#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget; anything longer fails the message, and the consumer's own
// backoff (1 minute doubling to an hour — retryDelaySeconds in flags.ts) takes over rather than holding a batch.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 20_000 };

export class HttpMondayClient implements MondayClient {
  private readonly transport: MondayGraphQL;

  // A fixed token, or the MONDAY_AUTH broker's provider (tokenProviderFor) — passed through to
  // MondayGraphQL, which re-asks a provider once on a 401.
  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options });
  }

  async findItemByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem | null> {
    const data = await this.transport.request<{ items_page_by_column_values: { items: MondayItem[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, columns: $columns) {
          items { id }
        }
      }`,
      { boardId, columns: [{ column_id: columnId, column_values: [value] }] }
    );
    const items = data.items_page_by_column_values.items;
    return items.length > 0 ? (items[0] as MondayItem) : null;
  }

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem> {
    // Not idempotent: a create that may have committed (5xx, timeout) throws AmbiguousWriteError
    // instead of retrying in-process; the consumer's retry re-runs the lookup-then-create path,
    // which adopts the item by its Eventbrite Order ID if the first create did land.
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

  async getItems(_boardId: number, itemIds: string[], columnIds: string[]): Promise<MondayItemColumns[]> {
    const result: MondayItemColumns[] = [];
    for (let i = 0; i < itemIds.length; i += ITEMS_BATCH_SIZE) {
      const data = await this.transport.request<{
        items: { id: string; name: string; state: string; column_values: { id: string; text: string | null; value: string | null }[] }[] | null;
      }>(
        // limit: without it items(ids:) returns at most 25 (Monday's default page size).
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: ${ITEMS_BATCH_SIZE}) {
            id
            name
            state
            column_values(ids: $columnIds) { id text value }
          }
        }`,
        { ids: itemIds.slice(i, i + ITEMS_BATCH_SIZE), columnIds }
      );
      for (const item of data.items ?? []) {
        result.push({
          id: item.id,
          name: item.name,
          state: item.state,
          columns: Object.fromEntries(item.column_values.map((c) => [c.id, c.text ?? ''])),
          values: Object.fromEntries(item.column_values.map((c) => [c.id, c.value ?? null])),
        });
      }
    }
    return result;
  }

  async notify(userId: number, itemId: string, text: string): Promise<void> {
    // Not idempotent: a retry after an ambiguous failure could ring the bell twice.
    await this.transport.request<{ create_notification: { text: string | null } }>(
      `mutation ($userId: ID!, $itemId: ID!, $text: String!) {
        create_notification(user_id: $userId, target_id: $itemId, text: $text, target_type: Project) {
          text
        }
      }`,
      { userId, itemId, text },
      { idempotent: false }
    );
  }
}
