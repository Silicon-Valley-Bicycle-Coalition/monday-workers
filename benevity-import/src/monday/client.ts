export interface MondayItem {
  id: string;
  name: string;
}

export interface MondayAsset {
  id: string;
  name: string;
  publicUrl: string;
}

export interface MondayClient {
  findItemsByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem[]>;
  findItemsByName(boardId: number, name: string): Promise<MondayItem[]>;
  getLinkedItemIds(itemId: string, columnId: string): Promise<string[]>;
  createItem(
    boardId: number,
    itemName: string,
    columnValues: Record<string, unknown>,
    groupId?: string
  ): Promise<MondayItem>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  fetchAsset(assetId: string): Promise<MondayAsset>;
}

const MONDAY_API_VERSION = '2026-01';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
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
      const detail =
        typeof json.error_message === 'string'
          ? `${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
          : JSON.stringify(json);
      throw new Error(`monday API: response contained no data — ${detail}`);
    }
    return json.data;
  }

  async findItemsByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem[]> {
    const data = await this.graphql<{ items_page_by_column_values: { items: MondayItem[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, columns: $columns) {
          items { id name }
        }
      }`,
      { boardId, columns: [{ column_id: columnId, column_values: [value] }] }
    );
    return data.items_page_by_column_values.items;
  }

  // Monday's item name is filterable through the same items_page_by_column_values query using
  // the reserved column_id "name" — no separate query shape needed.
  findItemsByName(boardId: number, name: string): Promise<MondayItem[]> {
    return this.findItemsByColumnValue(boardId, 'name', name);
  }

  async getLinkedItemIds(itemId: string, columnId: string): Promise<string[]> {
    const data = await this.graphql<{
      items: { column_values: { linked_item_ids?: string[] }[] }[];
    }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) {
          column_values(ids: $columnId) {
            ... on BoardRelationValue { linked_item_ids }
          }
        }
      }`,
      { itemId, columnId: [columnId] }
    );
    const item = data.items[0];
    if (!item || item.column_values.length === 0) return [];
    return item.column_values[0]?.linked_item_ids ?? [];
  }

  async createItem(
    boardId: number,
    itemName: string,
    columnValues: Record<string, unknown>,
    groupId?: string
  ): Promise<MondayItem> {
    const data = await this.graphql<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!, $groupId: String) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, group_id: $groupId) {
          id name
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues), groupId: groupId ?? null }
    );
    return data.create_item;
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

  async fetchAsset(assetId: string): Promise<MondayAsset> {
    const data = await this.graphql<{ assets: { id: string; name: string; public_url: string }[] }>(
      `query ($assetIds: [ID!]!) {
        assets(ids: $assetIds) { id name public_url }
      }`,
      { assetIds: [assetId] }
    );
    const asset = data.assets[0];
    if (!asset) {
      throw new Error(`monday API: asset "${assetId}" not found`);
    }
    return { id: asset.id, name: asset.name, publicUrl: asset.public_url };
  }
}
