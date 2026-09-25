import type { BoardSummary, ColumnDef, DocBlock, DocSummary, GroupDef, ItemRecord } from '../types';

// Pinned explicitly: Monday serves a request for a deprecated version as the *maintenance*
// version, so an unpinned or stale pin drifts silently. 2026-07 is current as of 2026-09; none of
// its breaking changes (users pagination, connection_board_ids, columns.capabilities) touch the
// queries here. Re-check developer.monday.com/api-reference/docs/api-versioning when bumping.
export const MONDAY_API_VERSION = '2026-07';
const BOARDS_PAGE_SIZE = 50;
const ITEMS_PAGE_SIZE = 100;
const DOCS_PAGE_SIZE = 50;

interface GraphQLError {
  message: string;
  extensions?: { code?: string; retry_in_seconds?: number };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
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
  // One page of items at a time, so a caller can stream a board to Drive without ever holding
  // the whole board in memory (issue #29).
  boardItemPages(boardId: string): AsyncIterable<ItemRecord[]>;
  listDocs(): Promise<DocSummary[]>;
  getDocBlocks(docId: string): Promise<DocBlock[]>;
}

export interface HttpMondayClientOptions {
  sleepFn?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

// Server-advised waits are honoured but capped, so one odd header can't eat the cron's
// 15-minute wall-time budget.
const MAX_ADVISED_WAIT_MS = 60_000;

// Retryable GraphQL error codes: the complexity budget (per-minute, per-query) and the
// rate/concurrency limits. Monday reports these in `errors[].extensions.code`, sometimes with
// `retry_in_seconds`.
const RETRYABLE_CODE = /complexity|rate_limit|concurrency/i;

export class HttpMondayClient implements MondayClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private apiUrl: string,
    private apiToken: string,
    options: HttpMondayClientOptions = {},
  ) {
    this.sleep = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  // Retry/backoff modelled on salesforce-import/src/load/monday.ts (a local copy, not a shared
  // package — cross-Worker sharing is issue #35). Every query here is a read, so unlike that
  // client there is no "ambiguous write" case: 429s, 5xx, network errors, complexity/rate-limit
  // GraphQL errors and Monday's HTTP-200-no-data rate-limit shape are all safe to retry.
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError = '';
    let advisedWaitMs = 0;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoffMs = 2 ** attempt * 1000 + Math.random() * 500;
        await this.sleep(Math.max(backoffMs, Math.min(advisedWaitMs, MAX_ADVISED_WAIT_MS)));
        advisedWaitMs = 0;
      }

      let response: Response;
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Monday expects the bare token, no "Bearer " prefix.
            Authorization: this.apiToken,
            'API-Version': MONDAY_API_VERSION,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        lastError = `network error: ${String(err)}`;
        continue;
      }

      if (response.status === 429) {
        advisedWaitMs = Number(response.headers.get('Retry-After') ?? '0') * 1000;
        lastError = 'HTTP 429';
        continue;
      }
      if (response.status >= 500) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      if (!response.ok) {
        throw new Error(`monday API: HTTP ${response.status}: ${await response.text()}`);
      }

      const json = (await response.json()) as GraphQLResponse<T>;
      if (json.errors && json.errors.length > 0) {
        lastError = json.errors.map((e) => e.message).join('; ');
        // A single query over the per-query complexity cap fails identically every time; only
        // the per-minute budget (and rate/concurrency limits) recover with a wait.
        const retryable = json.errors.find(
          (e) =>
            !/exceeds max complexity/i.test(e.message) &&
            (RETRYABLE_CODE.test(e.extensions?.code ?? '') || /complexity/i.test(e.message)),
        );
        if (retryable === undefined) throw new Error(`monday API: ${lastError}`);
        advisedWaitMs = (retryable.extensions?.retry_in_seconds ?? 0) * 1000;
        continue;
      }
      if (!json.data) {
        // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
        // Usually a rate limit, so retry; the exhausted-attempts error carries the detail.
        lastError =
          typeof json.error_message === 'string'
            ? `response contained no data — ${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
            : `response contained no data — ${JSON.stringify(json)}`;
        continue;
      }
      return json.data;
    }
    throw new Error(`monday API: exhausted ${this.maxAttempts} attempts — last error: ${lastError}`);
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

  async *boardItemPages(boardId: string): AsyncGenerator<ItemRecord[]> {
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
      yield page.items.map((item) => ({
        id: item.id,
        name: item.name,
        groupId: item.group?.id ?? null,
        columnValues: item.column_values.map((cv) => ({ id: cv.id, text: cv.text, value: cv.value })),
      }));
      cursor = page.cursor;
    } while (cursor !== null);
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
