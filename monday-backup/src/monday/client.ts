import type {
  AssetRecord,
  BoardSchema,
  BoardSummary,
  ColumnValue,
  DocBlock,
  DocSummary,
  ItemRecord,
  UpdateRecord,
  UpdateReply,
} from '../types';
import { MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';
import type { DailyUsage } from '../usage';

const BOARDS_PAGE_SIZE = 50;
// items_page allows up to 500, but each item now carries column values, typed connect/mirror
// fragments and asset metadata — 100 keeps one page's complexity and response size modest.
const ITEMS_PAGE_SIZE = 100;
const DOCS_PAGE_SIZE = 50;
const UPDATES_PAGE_SIZE = 100; // the documented maximum for `updates`
const BLOCKS_PAGE_SIZE = 100;

interface RawBlock {
  id: string;
  type: string;
  content: unknown;
  parent_block_id?: string | null;
  position?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: { id: string } | null;
}

function toBlock(b: RawBlock): DocBlock {
  return {
    id: b.id,
    type: b.type,
    content: b.content,
    parentBlockId: b.parent_block_id ?? null,
    position: b.position ?? null,
    createdAt: b.created_at ?? null,
    updatedAt: b.updated_at ?? null,
    createdById: b.created_by?.id ?? null,
  };
}

const ASSET_FIELDS = 'id name file_extension file_size created_at url uploaded_by { id }';

interface RawReply {
  id: string;
  body: string;
  text_body: string | null;
  created_at: string | null;
  updated_at: string | null;
  creator_id: string | null;
}

interface RawUpdate extends RawReply {
  item_id: string | null;
  replies: RawReply[] | null;
  assets: RawAsset[] | null;
}

function toReply(r: RawReply): UpdateReply {
  return { id: r.id, body: r.body, textBody: r.text_body, createdAt: r.created_at, updatedAt: r.updated_at, creatorId: r.creator_id };
}

function toUpdate(u: RawUpdate): UpdateRecord {
  return {
    ...toReply(u),
    itemId: u.item_id,
    replies: (u.replies ?? []).map(toReply),
    assets: (u.assets ?? []).map(toAsset),
  };
}

// Everything a restore needs from an item (issue #30). Connect-boards, mirror and dependency
// columns return `text: null` (and connect-boards `value: null`) on current API versions, so the
// linked item ids and display values are captured through their typed fragments explicitly.
// Subitems are items of their own `sub_items_board`, backed up like any board; `parent_item`
// is the link back.
const ITEM_FIELDS = `
  id
  name
  state
  created_at
  updated_at
  creator_id
  group { id }
  parent_item { id }
  column_values {
    id
    type
    text
    value
    ... on BoardRelationValue { linked_item_ids display_value }
    ... on DependencyValue { linked_item_ids display_value }
    ... on MirrorValue { display_value }
  }
  assets { ${ASSET_FIELDS} }
`;

interface RawColumnValue {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
  linked_item_ids?: (string | number)[] | null;
  display_value?: string | null;
}

interface RawAsset {
  id: string;
  name: string;
  file_extension: string | null;
  file_size: number | null;
  created_at: string | null;
  url: string | null;
  uploaded_by: { id: string } | null;
}

interface RawItem {
  id: string;
  name: string;
  state: string | null;
  created_at: string | null;
  updated_at: string | null;
  creator_id: string | null;
  group: { id: string } | null;
  parent_item: { id: string } | null;
  column_values: RawColumnValue[];
  assets: RawAsset[] | null;
}

interface ItemsPage {
  cursor: string | null;
  items: RawItem[];
}

interface RawBoard {
  id: string;
  name: string;
  workspace_id: string | null;
  state: string | null;
  type: string | null;
  board_kind: string | null;
  description: string | null;
  board_folder_id: string | null;
  permissions: string | null;
  item_terminology: string | null;
  updated_at: string | null;
}

function toColumnValue(cv: RawColumnValue): ColumnValue {
  const out: ColumnValue = { id: cv.id, type: cv.type, text: cv.text, value: cv.value };
  if (cv.linked_item_ids !== undefined && cv.linked_item_ids !== null) out.linkedItemIds = cv.linked_item_ids.map(String);
  if (cv.display_value !== undefined && cv.display_value !== null) out.displayValue = cv.display_value;
  return out;
}

function toAsset(a: RawAsset): AssetRecord {
  return {
    id: a.id,
    name: a.name,
    fileExtension: a.file_extension,
    fileSize: a.file_size,
    createdAt: a.created_at,
    url: a.url,
    uploadedById: a.uploaded_by?.id ?? null,
  };
}

function toItem(item: RawItem): ItemRecord {
  return {
    id: item.id,
    name: item.name,
    state: item.state,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    creatorId: item.creator_id,
    groupId: item.group?.id ?? null,
    parentItemId: item.parent_item?.id ?? null,
    columnValues: item.column_values.map(toColumnValue),
    assets: (item.assets ?? []).map(toAsset),
  };
}

function toBoard(b: RawBoard): BoardSummary {
  return {
    id: b.id,
    name: b.name,
    workspaceId: b.workspace_id,
    state: b.state,
    type: b.type,
    boardKind: b.board_kind,
    description: b.description,
    folderId: b.board_folder_id,
    permissions: b.permissions,
    itemTerminology: b.item_terminology,
    updatedAt: b.updated_at,
  };
}

export interface MondayClient {
  // Every board across every workspace this token can see, in every state (active, archived,
  // deleted — the caller decides what to skip). Top-level `boards` pagination is page-based.
  listBoards(): Promise<BoardSummary[]>;
  getBoardSchema(boardId: string): Promise<BoardSchema>;
  // One page of items at a time, so a caller can stream a board to Drive without ever holding
  // the whole board in memory (issue #29).
  boardItemPages(boardId: string): AsyncIterable<ItemRecord[]>;
  // Every update (comment) on the board and its items, with replies, a page at a time.
  boardUpdatePages(boardId: string): AsyncIterable<UpdateRecord[]>;
  listDocs(): Promise<DocSummary[]>;
  // A Doc's blocks a page at a time, in document order.
  docBlockPages(docId: string): AsyncIterable<DocBlock[]>;
}

export type HttpMondayClientOptions = MondayGraphQLOptions;

// Read-only client for the backup. Every call is a query, so all retryable failures are retried
// (see MondayGraphQL for the retry/backoff policy).
export class HttpMondayClient implements MondayClient {
  private readonly transport: MondayGraphQL;

  // A fixed token, or the MONDAY_AUTH broker's provider (tokenProviderFor) — passed through to
  // MondayGraphQL, which re-asks a provider once on a 401.
  constructor(apiUrl: string, apiToken: string | TokenProvider, options: HttpMondayClientOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, options);
  }

  private graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.transport.request<T>(query, variables);
  }

  async listBoards(): Promise<BoardSummary[]> {
    const out: BoardSummary[] = [];
    let page = 1;
    for (;;) {
      const data = await this.graphql<{ boards: RawBoard[] }>(
        `query ($limit: Int!, $page: Int!) {
          boards(limit: $limit, page: $page, state: all) {
            id
            name
            workspace_id
            state
            type
            board_kind
            description
            board_folder_id
            permissions
            item_terminology
            updated_at
          }
        }`,
        { limit: BOARDS_PAGE_SIZE, page },
      );
      out.push(...data.boards.map(toBoard));
      if (data.boards.length < BOARDS_PAGE_SIZE) break;
      page++;
    }
    return out;
  }

  // `state: all` in the three queries below: boards(ids:) returns only active boards by default, and
  // listBoards hands us archived ones too.
  async getBoardSchema(boardId: string): Promise<BoardSchema> {
    const data = await this.graphql<{
      boards: {
        columns: { id: string; title: string; type: string; settings_str: string; description: string | null }[];
        groups: { id: string; title: string; color: string | null; position: string | null }[];
      }[];
    }>(
      `query ($boardId: [ID!]) {
        boards(ids: $boardId, state: all) {
          columns { id title type settings_str description }
          groups { id title color position }
        }
      }`,
      { boardId: [boardId] },
    );
    const board = data.boards[0];
    if (board === undefined) {
      throw new Error(`monday API: board ${boardId} not found`);
    }
    return {
      columns: board.columns.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        settingsStr: c.settings_str,
        description: c.description,
      })),
      groups: board.groups.map((g) => ({ id: g.id, title: g.title, color: g.color, position: g.position })),
    };
  }

  // First page through boards { items_page }, then the cheaper root next_items_page with the
  // cursor (cursors stay valid for 60 minutes — far longer than one board takes).
  async *boardItemPages(boardId: string): AsyncGenerator<ItemRecord[]> {
    const first = await this.graphql<{ boards: { items_page: ItemsPage }[] }>(
      `query ($boardId: [ID!], $limit: Int!) {
        boards(ids: $boardId, state: all) {
          items_page(limit: $limit) { cursor items { ${ITEM_FIELDS} } }
        }
      }`,
      { boardId: [boardId], limit: ITEMS_PAGE_SIZE },
    );
    let page: ItemsPage | undefined = first.boards[0]?.items_page;
    while (page !== undefined) {
      yield page.items.map(toItem);
      if (page.cursor === null) return;
      const next: { next_items_page: ItemsPage } = await this.graphql<{ next_items_page: ItemsPage }>(
        `query ($cursor: String!, $limit: Int!) {
          next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${ITEM_FIELDS} } }
        }`,
        { cursor: page.cursor, limit: ITEMS_PAGE_SIZE },
      );
      page = next.next_items_page;
    }
  }

  // Kept out of the items query on purpose: nesting updates under 100 items multiplies that
  // query's complexity, while the board-level `updates` field pages them on their own.
  async *boardUpdatePages(boardId: string): AsyncGenerator<UpdateRecord[]> {
    for (let page = 1; ; page++) {
      const data = await this.graphql<{ boards: { updates: RawUpdate[] | null }[] }>(
        `query ($boardId: [ID!], $limit: Int!, $page: Int!) {
          boards(ids: $boardId, state: all) {
            updates(limit: $limit, page: $page) {
              id
              item_id
              body
              text_body
              created_at
              updated_at
              creator_id
              replies { id body text_body created_at updated_at creator_id }
              assets { ${ASSET_FIELDS} }
            }
          }
        }`,
        { boardId: [boardId], limit: UPDATES_PAGE_SIZE, page },
      );
      const updates = data.boards[0]?.updates ?? [];
      if (updates.length > 0) yield updates.map(toUpdate);
      if (updates.length < UPDATES_PAGE_SIZE) return;
    }
  }

  async listDocs(): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    let page = 1;
    for (;;) {
      const data = await this.graphql<{
        docs:
          | {
              id: string;
              object_id?: string | null;
              name: string;
              workspace_id: string | null;
              url: string | null;
              doc_kind?: string | null;
              doc_folder_id?: string | null;
              created_at?: string | null;
            }[]
          | null;
      }>(
        `query ($limit: Int!, $page: Int!) {
          docs(limit: $limit, page: $page) {
            id
            object_id
            name
            workspace_id
            url
            doc_kind
            doc_folder_id
            created_at
          }
        }`,
        { limit: DOCS_PAGE_SIZE, page },
      );
      const docs = data.docs ?? [];
      for (const doc of docs) {
        out.push({
          id: doc.id,
          objectId: doc.object_id ?? null,
          name: doc.name,
          workspaceId: doc.workspace_id,
          url: doc.url,
          docKind: doc.doc_kind ?? null,
          folderId: doc.doc_folder_id ?? null,
          createdAt: doc.created_at ?? null,
        });
      }
      if (docs.length < DOCS_PAGE_SIZE) break;
      page++;
    }
    return out;
  }

  // `blocks` defaults to 25 per page (issue #30: the old single query truncated every long Doc).
  // The maximum page size isn't documented, so a short page isn't trusted to be the last: paging
  // stops on an empty page, or if a page repeats one already seen (a `page` argument ignored).
  // Not yet exercised against a live account — confirm in Monday's API Explorer before the first
  // real deploy.
  async *docBlockPages(docId: string): AsyncGenerator<DocBlock[]> {
    const seen = new Set<string>();
    for (let page = 1; ; page++) {
      const data = await this.graphql<{ docs: { blocks: RawBlock[] | null }[] | null }>(
        `query ($docId: [ID!], $limit: Int!, $page: Int!) {
          docs(ids: $docId) {
            blocks(limit: $limit, page: $page) {
              id
              type
              content
              parent_block_id
              position
              created_at
              updated_at
              created_by { id }
            }
          }
        }`,
        { docId: [docId], limit: BLOCKS_PAGE_SIZE, page },
      );
      const doc = data.docs?.[0];
      if (doc === undefined) {
        throw new Error(`monday API: doc ${docId} not found`);
      }
      const blocks = doc.blocks ?? [];
      if (blocks.length === 0 || seen.has(blocks[0]!.id)) return;
      for (const block of blocks) seen.add(block.id);
      yield blocks.map(toBlock);
    }
  }

  // The account's daily API limit and per-day usage (platform_api; works on Pro, not only
  // Enterprise). Not part of MondayClient: the watchdog's usage check calls it, not the backup.
  async getDailyUsage(): Promise<DailyUsage> {
    const data = await this.graphql<{
      platform_api: {
        daily_limit: { total: number };
        daily_analytics: { last_updated: string | null; by_day: { day: string; usage: number }[] };
      };
    }>(
      `query {
        platform_api {
          daily_limit { total }
          daily_analytics { last_updated by_day { day usage } }
        }
      }`,
      {},
    );
    const { daily_limit, daily_analytics } = data.platform_api;
    return { limit: daily_limit.total, lastUpdated: daily_analytics.last_updated, byDay: daily_analytics.by_day };
  }
}
