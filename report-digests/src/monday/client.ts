import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';

export interface BoardColumn { id: string; title: string; type: string }
export interface Board { id: string; name: string; columns: BoardColumn[]; views: { id: string; name: string }[] }

export interface Rule { column_id: string; operator: string; compare_value: unknown }

export interface Item {
  id: string;
  name: string;
  // Column id → display text (null when blank); connect columns also carry their linked item ids.
  text: Map<string, string | null>;
  linked: Map<string, string[]>;
}

// An item read by id, possibly from any board: its columns are keyed by title, since a Donor link
// can point at People, People (Historical) or Organizations, whose column ids differ.
export interface LinkedItem { id: string; name: string; boardId: string; byTitle: Map<string, string | null> }

export interface MondayUser { id: string; email: string; enabled: boolean }

// What a digest needs from Monday; the fake in src/digests.test.ts implements the same surface.
export interface DigestsMondayClient {
  getBoard(boardId: number): Promise<Board | null>;
  // A list digest's items, refused past MAX_ITEMS (a list that long belongs in the view).
  queryItems(boardId: number, rules: Rule[], columnIds: string[]): Promise<Item[]>;
  // Every matching item, one cursor page at a time, with no cap: for a digest that aggregates.
  itemPages(boardId: number, rules: Rule[], columnIds: string[]): AsyncIterable<Item[]>;
  // Items by id from any board, with only the columns titled `titles` (bare titles).
  getItemsByTitle(ids: string[], titles: string[]): Promise<LinkedItem[]>;
  getUsers(ids: number[]): Promise<MondayUser[]>;
}

// A digest has no queue behind it: a few in-process attempts ride out a Monday blip or the
// per-minute complexity budget, and anything longer fails that digest (logged, so Workers Issues
// raises it) for an operator to rerun with POST /digests/run.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

// A filtered view should be tens or hundreds of items; this stops a filter that matched the whole
// board from paging it all into one email. Aggregating digests use itemPages, which has no cap.
export const MAX_ITEMS = 5000;

interface RawPage { cursor: string | null; items: RawItem[] }
interface RawItem { id: string; name: string; column_values: { id: string; text: string | null; linked_item_ids?: string[]; display_value?: string }[] }

function toItem(raw: RawItem, columnIds: string[]): Item {
  const text = new Map<string, string | null>(columnIds.map((id) => [id, null]));
  const linked = new Map<string, string[]>();
  for (const cv of raw.column_values) {
    // A connect column's text is always null; its linked items' names are in display_value.
    const value = cv.display_value ?? cv.text;
    text.set(cv.id, value === null || value === '' ? null : value);
    if (cv.linked_item_ids !== undefined) linked.set(cv.id, cv.linked_item_ids);
  }
  return { id: raw.id, name: raw.name, text, linked };
}

export class HttpMondayClient implements DigestsMondayClient {
  private readonly transport: MondayGraphQL;

  // A fixed token, or the MONDAY_AUTH broker's provider (tokenProviderFor) — passed through to
  // MondayGraphQL, which re-asks a provider once on a 401.
  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  // One client serves one cron run or request, so the three Monday 08:00 digests share one read
  // of the Donations board's schema. A failed read isn't kept: the next digest tries again.
  private readonly boards = new Map<number, Promise<Board | null>>();

  getBoard(boardId: number): Promise<Board | null> {
    let board = this.boards.get(boardId);
    if (!board) {
      board = this.transport.request<{ boards: Board[] }>(
        `query ($boardId: [ID!]) { boards(ids: $boardId) { id name columns { id title type } views { id name } } }`,
        { boardId: [String(boardId)] },
      ).then((data) => data.boards[0] ?? null);
      board.catch(() => this.boards.delete(boardId));
      this.boards.set(boardId, board);
    }
    return board;
  }

  async *itemPages(boardId: number, rules: Rule[], columnIds: string[]): AsyncGenerator<Item[]> {
    const fields = `cursor items { id name column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids display_value } } }`;
    const first = await this.transport.request<{ boards: { items_page: RawPage }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $rules: [ItemsQueryRule!]) {
        boards(ids: $boardId) { items_page(limit: 500, query_params: { rules: $rules }) { ${fields} } }
      }`,
      { boardId: [String(boardId)], columnIds, rules },
    );
    let page = first.boards[0]?.items_page;
    while (page) {
      yield page.items.map((raw) => toItem(raw, columnIds));
      if (!page.cursor) break;
      const next = await this.transport.request<{ next_items_page: RawPage }>(
        `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${fields} } }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
    }
  }

  async queryItems(boardId: number, rules: Rule[], columnIds: string[]): Promise<Item[]> {
    const items: Item[] = [];
    for await (const page of this.itemPages(boardId, rules, columnIds)) {
      items.push(...page);
      if (items.length > MAX_ITEMS) throw new Error(`board ${boardId}: filter matched more than ${MAX_ITEMS} items — check the digest's rules`);
    }
    return items;
  }

  async getItemsByTitle(ids: string[], titles: string[]): Promise<LinkedItem[]> {
    const out: LinkedItem[] = [];
    // items(ids:) takes at most 100 ids per call.
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      // A Donor link can point at People, People (Historical) or Organizations, whose column ids
      // differ: find each item's board, resolve the titles there, then read just those columns —
      // not every column, which on People includes the Gift Ledger JSON and Windfall data.
      const found = await this.transport.request<{ items: { id: string; name: string; board: { id: string } }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id name board { id } } }`,
        { ids: chunk },
      );
      if (found.items.length === 0) continue;
      const boardIds = [...new Set(found.items.map((item) => item.board.id))];
      const schema = await this.transport.request<{ boards: { id: string; columns: { id: string; title: string }[] }[] }>(
        `query ($boardIds: [ID!]) { boards(ids: $boardIds) { id columns { id title } } }`,
        { boardIds },
      );
      // Board id → column id → bare title, for the requested titles only.
      const wanted = new Map(schema.boards.map((b) => [b.id, new Map(
        b.columns.filter((c) => titles.includes(bareTitle(c.title))).map((c) => [c.id, bareTitle(c.title)]),
      )]));
      const columnIds = [...new Set([...wanted.values()].flatMap((cols) => [...cols.keys()]))];
      const values = new Map<string, { id: string; text: string | null }[]>();
      if (columnIds.length > 0) {
        const data = await this.transport.request<{ items: { id: string; column_values: { id: string; text: string | null }[] }[] }>(
          `query ($ids: [ID!], $columnIds: [String!]) { items(ids: $ids, limit: 100) { id column_values(ids: $columnIds) { id text } } }`,
          { ids: found.items.map((item) => item.id), columnIds },
        );
        for (const item of data.items) values.set(item.id, item.column_values);
      }
      for (const item of found.items) {
        const cols = wanted.get(item.board.id) ?? new Map<string, string>();
        const byTitle = new Map<string, string | null>(titles.map((t) => [t, null]));
        for (const cv of values.get(item.id) ?? []) {
          const title = cols.get(cv.id);
          if (title !== undefined) byTitle.set(title, cv.text === null || cv.text === '' ? null : cv.text);
        }
        out.push({ id: item.id, name: item.name, boardId: item.board.id, byTitle });
      }
    }
    return out;
  }

  async getUsers(ids: number[]): Promise<MondayUser[]> {
    const data = await this.transport.request<{ users: MondayUser[] }>(
      `query ($ids: [ID!]) { users(ids: $ids) { id email enabled } }`,
      { ids: ids.map(String) },
    );
    return data.users;
  }
}
