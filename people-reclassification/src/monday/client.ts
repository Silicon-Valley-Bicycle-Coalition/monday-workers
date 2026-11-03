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

// What a pass needs from Monday; the fake in src/pass.test.ts implements the same surface.
export interface ReclassificationMondayClient {
  getBoardSchema(boardId: number): Promise<BoardSchema | null>;
  pageItems(boardId: number, columnIds: string[], cursor: string | null): Promise<ItemsPage>;
  // Which board an item is on now — settles a 'planned'/'ambiguous' ledger row from an
  // interrupted pass. null = deleted or not visible.
  getItemBoardId(itemId: string): Promise<string | null>;
  // One item's values, for a single-person move. null = deleted or not visible.
  getItemValues(itemId: string, columnIds: string[]): Promise<PageItem | null>;
  moveItemToBoard(itemId: string, boardId: number, groupId: string, mapping: ColumnMapping[]): Promise<void>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string>;
}

// API-Version comes from the transport's single pin (#39). A quarterly pass has no queue behind
// it, so the transport's own retries are the retry policy: a few in-process attempts ride out a
// Monday blip or the per-minute complexity budget; anything longer fails the pass, which the
// next day's cron continues (src/duties.ts).
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

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

  async pageItems(boardId: number, columnIds: string[], cursor: string | null): Promise<ItemsPage> {
    // 500 is items_page's documented maximum; a People board of ~8k is 16 subrequests.
    const data = await this.graphql<{ boards: { items_page: { cursor: string | null; items: RawItem[] } }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $cursor: String) {
        boards(ids: $boardId) {
          items_page(limit: 500, cursor: $cursor) {
            cursor
            items { id column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      }`,
      { boardId: [String(boardId)], columnIds, cursor },
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
