import type { BoardSummary, ColumnDef, DocBlock, DocSummary, GroupDef, ItemRecord } from '../types';

const MONDAY_API_VERSION = '2026-01';
const BOARDS_PAGE_SIZE = 50;
const ITEMS_PAGE_SIZE = 100;
const DOCS_PAGE_SIZE = 50;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
  error_message?: string;
  status_code?: number;
}

interface ItemsPageItem {
  id: string;
  name: string;
  group: { id: string } | null;
  column_values: { id: string; text: string | null; value: string | null }[];
}

interface ItemsPage {
  cursor: string | null;
  items: ItemsPageItem[];
}

interface ItemsPageResponse {
  boards: { items_page: ItemsPage }[];
}

export interface MondayClient {
  // Every board across every workspace this token can see — top-level `boards` pagination
  // is page-based (not cursor-based like items_page within a board).
  listBoards(): Promise<BoardSummary[]>;
  getBoardSchema(boardId: string): Promise<{ columns: ColumnDef[]; groups: GroupDef[] }>;
  getBoardItems(boardId: string): Promise<ItemRecord[]>;
  listDocs(): Promise<DocSummary[]>;
  getDocBlocks(docId: string): Promise<DocBlock[]>;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Monday expects the bare token, no "Bearer " prefix.
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

  async listBoards(): Promise<BoardSummary[]> {
    const out: BoardSummary[] = [];
    let page = 1;
    for (;;) {
      const data = await this.graphql<{
        boards: { id: string; name: string; workspace_id: string | null }[];
      }>(
        `query ($limit: Int!, $page: Int!) {
          boards(limit: $limit, page: $page) {
            id
            name
            workspace_id
          }
        }`,
        { limit: BOARDS_PAGE_SIZE, page },
      );
      for (const board of data.boards) {
        out.push({ id: board.id, name: board.name, workspaceId: board.workspace_id });
      }
      if (data.boards.length < BOARDS_PAGE_SIZE) break;
      page++;
    }
    return out;
  }

  async getBoardSchema(boardId: string): Promise<{ columns: ColumnDef[]; groups: GroupDef[] }> {
    const data = await this.graphql<{
      boards: {
        columns: { id: string; title: string; type: string; settings_str: string }[];
        groups: { id: string; title: string }[];
      }[];
    }>(
      `query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns { id title type settings_str }
          groups { id title }
        }
      }`,
      { boardId: [boardId] },
    );
    const board = data.boards[0];
    if (board === undefined) {
      throw new Error(`monday API: board ${boardId} not found`);
    }
    return {
      columns: board.columns.map((c) => ({ id: c.id, title: c.title, type: c.type, settingsStr: c.settings_str })),
      groups: board.groups.map((g) => ({ id: g.id, title: g.title })),
    };
  }

  async getBoardItems(boardId: string): Promise<ItemRecord[]> {
    const out: ItemRecord[] = [];
    let cursor: string | null = null;
    do {
      const data: ItemsPageResponse = await this.graphql<ItemsPageResponse>(
        `query ($boardId: [ID!], $limit: Int!, $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: $limit, cursor: $cursor) {
              cursor
              items {
                id
                name
                group { id }
                column_values { id text value }
              }
            }
          }
        }`,
        { boardId: [boardId], limit: ITEMS_PAGE_SIZE, cursor },
      );
      const page: ItemsPage | undefined = data.boards[0]?.items_page;
      if (page === undefined) break;
      for (const item of page.items) {
        out.push({
          id: item.id,
          name: item.name,
          groupId: item.group?.id ?? null,
          columnValues: item.column_values.map((cv) => ({ id: cv.id, text: cv.text, value: cv.value })),
        });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return out;
  }

  async listDocs(): Promise<DocSummary[]> {
    const out: DocSummary[] = [];
    let page = 1;
    for (;;) {
      const data = await this.graphql<{
        docs: { id: string; name: string; workspace_id: string | null; url: string | null }[] | null;
      }>(
        `query ($limit: Int!, $page: Int!) {
          docs(limit: $limit, page: $page) {
            id
            name
            workspace_id
            url
          }
        }`,
        { limit: DOCS_PAGE_SIZE, page },
      );
      const docs = data.docs ?? [];
      for (const doc of docs) {
        out.push({ id: doc.id, name: doc.name, workspaceId: doc.workspace_id, url: doc.url });
      }
      if (docs.length < DOCS_PAGE_SIZE) break;
      page++;
    }
    return out;
  }

  async getDocBlocks(docId: string): Promise<DocBlock[]> {
    // `Doc.blocks` hasn't been exercised against a live account (no integration token
    // provisioned yet — see monday-backup/README.md's "APIs & auth"). Verify this query
    // against Monday's current GraphQL schema (API Explorer) before the first real deploy.
    const data = await this.graphql<{
      docs: { blocks: { id: string; type: string; content: string | null }[] }[] | null;
    }>(
      `query ($docId: [ID!]) {
        docs(ids: $docId) {
          blocks {
            id
            type
            content
          }
        }
      }`,
      { docId: [docId] },
    );
    const doc = data.docs?.[0];
    if (doc === undefined) {
      throw new Error(`monday API: doc ${docId} not found`);
    }
    return doc.blocks.map((b) => ({ id: b.id, type: b.type, content: b.content }));
  }
}
