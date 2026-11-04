import { MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export interface MondayItem {
  id: string;
}

export interface MondayClient {
  findItemByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem | null>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

// API-Version comes from the transport's single pin (MONDAY_API_VERSION in graphql.ts, #39).
// Queue-consumer tuning (#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget; anything longer fails the message, and the consumer's own
// backoff (1 minute doubling to an hour — flags.ts retryDelaySeconds) takes over rather than
// holding a batch.
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
    // which adopts the item if the first create did land.
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
}
