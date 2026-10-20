import { MondayGraphQL, type MondayGraphQLOptions } from './graphql';

export interface MondayClient {
  // Every matching item id (a household address matches several People), not just the first.
  findItemIdsByColumnValue(boardId: number, columnId: string, value: string): Promise<string[]>;
  findUserIdByEmail(email: string): Promise<number | null>;
  // Ids linked through a board-relation column (Affiliation -> Person).
  getConnectedItemIds(itemId: string, columnId: string): Promise<string[]>;
  boardItemsCount(boardId: number): Promise<number>;
  createItem(boardId: number, name: string, columnValues: Record<string, unknown>): Promise<string>;
}

// Queue-consumer tuning (#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget; longer waits are left to the queue's own backoff.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 20_000 };

export class HttpMondayClient implements MondayClient {
  private readonly transport: MondayGraphQL;

  constructor(apiUrl: string, apiToken: string, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options });
  }

  async findItemIdsByColumnValue(boardId: number, columnId: string, value: string): Promise<string[]> {
    // No cursor pagination: one address matching more than 100 items is not a real case.
    const data = await this.transport.request<{ items_page_by_column_values: { items: { id: string }[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, limit: 100, columns: $columns) {
          items { id }
        }
      }`,
      { boardId, columns: [{ column_id: columnId, column_values: [value] }] }
    );
    return data.items_page_by_column_values.items.map((item) => item.id);
  }

  async findUserIdByEmail(email: string): Promise<number | null> {
    const data = await this.transport.request<{ users: { id: string }[] }>(
      `query ($email: String!) {
        users(emails: [$email]) { id }
      }`,
      { email }
    );
    const first = data.users[0];
    return first ? Number(first.id) : null;
  }

  async getConnectedItemIds(itemId: string, columnId: string): Promise<string[]> {
    const data = await this.transport.request<{ items: { column_values: { linked_item_ids?: string[] }[] }[] }>(
      `query ($itemId: ID!, $columnId: String!) {
        items(ids: [$itemId]) {
          column_values(ids: [$columnId]) {
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }`,
      { itemId, columnId }
    );
    return data.items[0]?.column_values[0]?.linked_item_ids ?? [];
  }

  async boardItemsCount(boardId: number): Promise<number> {
    const data = await this.transport.request<{ boards: { items_count: number }[] }>(
      `query ($boardId: ID!) {
        boards(ids: [$boardId]) { items_count }
      }`,
      { boardId }
    );
    const board = data.boards[0];
    if (!board) throw new Error(`Monday did not return board ${boardId}`);
    return board.items_count;
  }

  async createItem(boardId: number, name: string, columnValues: Record<string, unknown>): Promise<string> {
    // Not idempotent: a create that may have committed (5xx, timeout) throws AmbiguousWriteError
    // instead of retrying in-process; the dedupe ledger decides what a queue retry does next.
    const data = await this.transport.request<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemName: name, columnValues: JSON.stringify(columnValues) },
      { idempotent: false }
    );
    return data.create_item.id;
  }
}
