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
  // The ids linked from one board-relation column across several items, flattened (one request
  // per 100 items; none for an empty list).
  getLinkedItemIds(itemIds: string[], columnId: string): Promise<string[]>;
  // Each item's label in one status column, keyed by item id (null when unset); one request per
  // 100 items, none for an empty list.
  getStatusLabels(itemIds: string[], columnId: string): Promise<Map<string, string | null>>;
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
  // The board an item lives on and the ids of the assets in one of its file columns; null when
  // the item doesn't exist. Lets the upload webhook refuse an asset id that isn't in the Uploads
  // board's file column (GL#106).
  fetchItemAssets(itemId: string, fileColumnId: string): Promise<{ boardId: string; assetIds: string[] } | null>;
}

// API-Version comes from the transport's single pin (MONDAY_API_VERSION in graphql.ts, GL#39).
// Queue-consumer tuning (GL#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget; anything longer fails the message, and the consumer's own
// backoff (1 minute doubling to an hour — retryDelaySeconds in flags.ts) takes over rather than holding a batch.
// items(ids:) accepts at most 100 ids per call.
const ITEMS_BATCH_SIZE = 100;

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

  async getLinkedItemIds(itemIds: string[], columnId: string): Promise<string[]> {
    const linked: string[] = [];
    for (let i = 0; i < itemIds.length; i += ITEMS_BATCH_SIZE) {
      const ids = itemIds.slice(i, i + ITEMS_BATCH_SIZE);
      const data = await this.transport.request<{
        items: { column_values: { linked_item_ids?: string[] }[] }[];
      }>(
        // limit: without it items(ids:) returns at most 25 (Monday's default page size).
        `query ($ids: [ID!], $columnId: [String!]) {
          items(ids: $ids, limit: ${ITEMS_BATCH_SIZE}) {
            column_values(ids: $columnId) {
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }`,
        { ids, columnId: [columnId] }
      );
      for (const item of data.items) linked.push(...(item.column_values[0]?.linked_item_ids ?? []));
    }
    return linked;
  }

  async getStatusLabels(itemIds: string[], columnId: string): Promise<Map<string, string | null>> {
    const labels = new Map<string, string | null>();
    for (let i = 0; i < itemIds.length; i += ITEMS_BATCH_SIZE) {
      const ids = itemIds.slice(i, i + ITEMS_BATCH_SIZE);
      const data = await this.transport.request<{
        items: { id: string; column_values: { label?: string | null }[] }[];
      }>(
        `query ($ids: [ID!], $columnId: [String!]) {
          items(ids: $ids, limit: ${ITEMS_BATCH_SIZE}) {
            id
            column_values(ids: $columnId) {
              ... on StatusValue { label }
            }
          }
        }`,
        { ids, columnId: [columnId] }
      );
      for (const item of data.items) labels.set(String(item.id), item.column_values[0]?.label ?? null);
    }
    return labels;
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

  async fetchItemAssets(itemId: string, fileColumnId: string): Promise<{ boardId: string; assetIds: string[] } | null> {
    const data = await this.transport.request<{
      items: {
        board: { id: string } | null;
        column_values: { files?: { asset_id?: string | number }[] | null }[] | null;
      }[];
    }>(
      `query ($itemIds: [ID!]!, $columnIds: [String!]) {
        items(ids: $itemIds) {
          board { id }
          column_values(ids: $columnIds) {
            ... on FileValue { files { ... on FileAssetValue { asset_id } } }
          }
        }
      }`,
      { itemIds: [itemId], columnIds: [fileColumnId] }
    );
    const item = data.items[0];
    if (!item?.board) return null;
    const assetIds = (item.column_values ?? [])
      .flatMap((value) => value.files ?? [])
      .flatMap((file) => (file.asset_id === undefined ? [] : [String(file.asset_id)]));
    return { boardId: String(item.board.id), assetIds };
  }
}
