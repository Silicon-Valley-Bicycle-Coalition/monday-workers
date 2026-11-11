import { MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

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
  // Archive, not delete: reversible from the board's archive if it was ever the wrong item.
  archiveItem(itemId: string): Promise<void>;
  fetchAsset(assetId: string): Promise<MondayAsset>;
  // The board an item lives on and the ids of the assets attached to it; null when the item
  // doesn't exist. Lets the upload webhook refuse an asset id that isn't on the Uploads board (#106).
  fetchItemAssets(itemId: string): Promise<{ boardId: string; assetIds: string[] } | null>;
}

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

  async findItemsByColumnValue(boardId: number, columnId: string, value: string): Promise<MondayItem[]> {
    const data = await this.transport.request<{ items_page_by_column_values: { items: MondayItem[] } }>(
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
    const data = await this.transport.request<{
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
    // Not idempotent: a create that may have committed (5xx, timeout) throws AmbiguousWriteError
    // instead of retrying in-process; the consumer's retry re-runs the lookup-then-create path
    // (gifts by Benevity Transaction ID, worklist items by key), which adopts it if it landed.
    const data = await this.transport.request<{ create_item: MondayItem }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!, $groupId: String) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, group_id: $groupId) {
          id name
        }
      }`,
      { boardId, itemName, columnValues: JSON.stringify(columnValues), groupId: groupId ?? null },
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

  async archiveItem(itemId: string): Promise<void> {
    await this.transport.request<{ archive_item: { id: string } }>(
      `mutation ($itemId: ID!) {
        archive_item(item_id: $itemId) { id }
      }`,
      { itemId }
    );
  }

  async fetchAsset(assetId: string): Promise<MondayAsset> {
    const data = await this.transport.request<{ assets: { id: string; name: string; public_url: string }[] }>(
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

  async fetchItemAssets(itemId: string): Promise<{ boardId: string; assetIds: string[] } | null> {
    const data = await this.transport.request<{
      items: { board: { id: string } | null; assets: { id: string }[] | null }[];
    }>(
      `query ($itemIds: [ID!]!) {
        items(ids: $itemIds) { board { id } assets { id } }
      }`,
      { itemIds: [itemId] }
    );
    const item = data.items[0];
    if (!item?.board) return null;
    return { boardId: String(item.board.id), assetIds: (item.assets ?? []).map((a) => String(a.id)) };
  }
}
