import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider, type RequestOptions } from './graphql';
import type { BoardColumn, ColumnMapping } from '../columns';

export interface BoardSchema {
  id: string;
  name: string;
  itemsCount: number;
  itemsLimit: number | null;
  columns: BoardColumn[];
  groups: { id: string; title: string }[];
}

export interface PageItem {
  id: string;
  // Column id → text (null when blank); connect columns also carry their linked item ids.
  text: Map<string, string | null>;
  linked: Map<string, string[]>;
}

export interface ItemsPage { items: PageItem[]; cursor: string | null }

// A server-side filter for pageItems: only items whose date column is on or after dateISO
// (YYYY-MM-DD). A blank date doesn't match.
export interface PageFilter { dateOnOrAfter: { columnId: string; dateISO: string } }

// What a pass needs from Monday; the fake in src/pass.test.ts implements the same surface.
export interface ReclassificationMondayClient {
  getBoardSchema(boardId: number): Promise<BoardSchema | null>;
  // filter applies from the first page on; pass the same one with every cursor.
  pageItems(boardId: number, columnIds: string[], cursor: string | null, filter?: PageFilter): Promise<ItemsPage>;
  // Which board an item is on now — settles a 'planned'/'ambiguous' ledger row from an
  // interrupted pass. null = deleted or not visible.
  getItemBoardId(itemId: string): Promise<string | null>;
  // One item's values, for a single-person move. null = deleted or not visible.
  getItemValues(itemId: string, columnIds: string[]): Promise<PageItem | null>;
  moveItemToBoard(itemId: string, boardId: number, groupId: string, mapping: ColumnMapping[]): Promise<void>;
  // Items on a board whose status column shows this label; the board isn't paged in full.
  findItemsByStatus(boardId: number, columnId: string, label: string): Promise<string[]>;
  // Column id → value. Writing the same values twice is harmless, so the transport may retry it.
  writeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>): Promise<void>;
  postUpdate(itemId: string, body: string): Promise<void>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string>;
}

// API-Version comes from the transport's single pin (#39). A quarterly pass has no queue behind
// it, so the transport's own retries are the retry policy: a few in-process attempts ride out a
// Monday blip or the per-minute complexity budget; anything longer fails the pass, which the
// next day's cron continues (src/duties.ts).
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

interface IdsPage { cursor: string | null; items: { id: string }[] }
interface RawColumnValue { id: string; text: string | null; linked_item_ids?: string[] }
interface RawItem { id: string; column_values: RawColumnValue[] }

function toPageItem(item: RawItem, columnIds: string[]): PageItem {
  const text = new Map<string, string | null>(columnIds.map((id) => [id, null]));
  const linked = new Map<string, string[]>();
  for (const cv of item.column_values) {
    text.set(cv.id, cv.text === null || cv.text === '' ? null : cv.text);
    if (cv.linked_item_ids !== undefined) linked.set(cv.id, cv.linked_item_ids);
  }
  return { id: item.id, text, linked };
}

export class HttpMondayClient implements ReclassificationMondayClient {
  private readonly transport: MondayGraphQL;

  // A fixed token, or the MONDAY_AUTH broker's provider (tokenProviderFor) — passed through to
  // MondayGraphQL, which re-asks a provider once on a 401.
  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  private graphql<T>(query: string, variables: Record<string, unknown>, requestOptions?: RequestOptions): Promise<T> {
    return this.transport.request<T>(query, variables, requestOptions);
  }

  async getBoardSchema(boardId: number): Promise<BoardSchema | null> {
    const data = await this.graphql<{
      boards: { id: string; name: string; items_count: number; items_limit: number | null;
        columns: BoardColumn[]; groups: { id: string; title: string }[] }[];
    }>(
      `query ($boardId: [ID!]) {
        boards(ids: $boardId) { id name items_count items_limit columns { id title type } groups { id title } }
      }`,
      { boardId: [String(boardId)] },
    );
    const b = data.boards[0];
    if (b === undefined) return null;
    return { id: b.id, name: b.name, itemsCount: b.items_count, itemsLimit: b.items_limit, columns: b.columns, groups: b.groups };
  }

  async pageItems(boardId: number, columnIds: string[], cursor: string | null, filter?: PageFilter): Promise<ItemsPage> {
    // The rule goes on the first page only: a cursor already encodes the query it came from.
    const rule = filter?.dateOnOrAfter;
    const query = cursor === null && rule !== undefined
      ? { rules: [{ column_id: rule.columnId, compare_value: ['EXACT', rule.dateISO], operator: 'greater_than_or_equals' }] }
      : null;
    // 500 is items_page's documented maximum; a People board of ~8k is 16 subrequests.
    const data = await this.graphql<{ boards: { items_page: { cursor: string | null; items: RawItem[] } }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $cursor: String, $query: ItemsQuery) {
        boards(ids: $boardId) {
          items_page(limit: 500, cursor: $cursor, query_params: $query) {
            cursor
            items { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      }`,
      { boardId: [String(boardId)], columnIds, cursor, query },
    );
    const page = data.boards[0]?.items_page;
    if (page === undefined) return { items: [], cursor: null };
    return {
      cursor: page.cursor,
      items: page.items.map((item) => toPageItem(item, columnIds)),
    };
  }

  async getItemBoardId(itemId: string): Promise<string | null> {
    const data = await this.graphql<{ items: { board: { id: string } }[] }>(
      `query ($itemId: ID!) { items(ids: [$itemId]) { board { id } } }`,
      { itemId },
    );
    return data.items[0]?.board.id ?? null;
  }

  async getItemValues(itemId: string, columnIds: string[]): Promise<PageItem | null> {
    const data = await this.graphql<{ items: RawItem[] }>(
      `query ($itemId: ID!, $columnIds: [String!]) {
        items(ids: [$itemId]) { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } }
      }`,
      { itemId, columnIds },
    );
    const item = data.items[0];
    return item === undefined ? null : toPageItem(item, columnIds);
  }

  async moveItemToBoard(itemId: string, boardId: number, groupId: string, mapping: ColumnMapping[]): Promise<void> {
    await this.graphql<{ move_item_to_board: { id: string } }>(
      `mutation ($itemId: ID!, $boardId: ID!, $groupId: ID!, $mapping: [ColumnMappingInput!]) {
        move_item_to_board(item_id: $itemId, board_id: $boardId, group_id: $groupId, columns_mapping: $mapping) { id }
      }`,
      { itemId, boardId: String(boardId), groupId, mapping },
      // A move that may have committed must not be retried blind: a second move of an item already
      // on the target board errors, and the ledger row must record the ambiguity instead.
      { idempotent: false },
    );
  }

  async findItemsByStatus(boardId: number, columnId: string, label: string): Promise<string[]> {
    const settings = await this.graphql<{ boards: { columns: { settings_str: string }[] }[] }>(
      `query ($boardId: [ID!], $columnId: [String!]) { boards(ids: $boardId) { columns(ids: $columnId) { settings_str } } }`,
      { boardId: [String(boardId)], columnId: [columnId] },
    );
    const labels = (JSON.parse(settings.boards[0]?.columns[0]?.settings_str ?? '{}') as { labels?: Record<string, string> }).labels ?? {};
    // Status rules compare by label index, which differs per board.
    const index = Object.entries(labels).find(([, text]) => text === label)?.[0];
    if (index === undefined) throw new Error(`board ${boardId}: column ${columnId} has no label "${label}"`);

    const query = { rules: [{ column_id: columnId, compare_value: [Number(index)], operator: 'any_of' }] };
    const ids: string[] = [];
    let page = (await this.graphql<{ boards: { items_page: IdsPage }[] }>(
      `query ($boardId: [ID!], $query: ItemsQuery) { boards(ids: $boardId) { items_page(limit: 500, query_params: $query) { cursor items { id } } } }`,
      { boardId: [String(boardId)], query },
    )).boards[0]?.items_page ?? { cursor: null, items: [] };
    ids.push(...page.items.map((i) => i.id));
    while (page.cursor !== null) {
      page = (await this.graphql<{ next_items_page: IdsPage }>(
        `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id } } }`,
        { cursor: page.cursor },
      )).next_items_page;
      ids.push(...page.items.map((i) => i.id));
    }
    return ids;
  }

  async writeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>): Promise<void> {
    await this.graphql<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
      }`,
      { boardId: String(boardId), itemId, values: JSON.stringify(values) },
    );
  }

  async postUpdate(itemId: string, body: string): Promise<void> {
    await this.graphql<{ create_update: { id: string } }>(
      `mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId, body },
      { idempotent: false },
    );
  }

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string> {
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
      }`,
      { boardId: String(boardId), itemName, columnValues: JSON.stringify(columnValues) },
      { idempotent: false },
    );
    return data.create_item.id;
  }
}
