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

const MONDAY_API_VERSION = '2026-01';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  // monday.com returns HTTP 200 with this non-GraphQL shape for some auth and rate-limit
  // failures — no `data`, no `errors` array.
  error_message?: string;
  status_code?: number;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
        'API-Version': MONDAY_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday API: HTTP ${response.status}`);
    }
    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`monday API: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) {
      // Without this, `json.data` is undefined and the caller fails downstream with something
      // like "Cannot read properties of undefined" instead of the server's actual message.
      const detail =
        typeof json.error_message === 'string'
          ? `${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
          : JSON.stringify(json);
      throw new Error(`monday API: response contained no data — ${detail}`);
    }
    return json.data;
  }

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<MondayItem> {
    const data = await this.graphql<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues) }
    );
    return data.create_item;
  }

  async getItem(itemId: string): Promise<MondayItemSnapshot | null> {
    const data = await this.graphql<{
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
    const data = await this.graphql<{ items_page_by_column_values: { items: { id: string }[] } }>(
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
    await this.graphql<{ change_multiple_column_values: MondayItem }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues) }
    );
  }
}
