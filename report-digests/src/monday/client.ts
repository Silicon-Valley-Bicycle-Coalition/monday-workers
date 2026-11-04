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
  queryItems(boardId: number, rules: Rule[], columnIds: string[]): Promise<Item[]>;
  getItemsByTitle(ids: string[]): Promise<LinkedItem[]>;
  getUsers(ids: number[]): Promise<MondayUser[]>;
}

// A digest has no queue behind it: a few in-process attempts ride out a Monday blip or the
// per-minute complexity budget, and anything longer fails that digest (logged, so Workers Issues
// raises it) for an operator to rerun with POST /digests/run.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

// A filtered view should be tens or hundreds of items; this stops a filter that matched the whole
// board from paging it all into one email.
export const MAX_ITEMS = 5000;

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

  async getBoard(boardId: number): Promise<Board | null> {
    const data = await this.transport.request<{ boards: Board[] }>(
      `query ($boardId: [ID!]) { boards(ids: $boardId) { id name columns { id title type } views { id name } } }`,
      { boardId: [String(boardId)] },
    );
    return data.boards[0] ?? null;
  }

  async queryItems(boardId: number, rules: Rule[], columnIds: string[]): Promise<Item[]> {
    const fields = `cursor items { id name column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids display_value } } }`;
    const first = await this.transport.request<{ boards: { items_page: { cursor: string | null; items: RawItem[] } }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $rules: [ItemsQueryRule!]) {
        boards(ids: $boardId) { items_page(limit: 500, query_params: { rules: $rules }) { ${fields} } }
      }`,
      { boardId: [String(boardId)], columnIds, rules },
    );
    let page = first.boards[0]?.items_page;
    const items: Item[] = [];
    while (page) {
      items.push(...page.items.map((raw) => toItem(raw, columnIds)));
      if (items.length > MAX_ITEMS) throw new Error(`board ${boardId}: filter matched more than ${MAX_ITEMS} items — check the digest's rules`);
      if (!page.cursor) break;
      const next = await this.transport.request<{ next_items_page: { cursor: string | null; items: RawItem[] } }>(
        `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${fields} } }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
    }
    return items;
  }

  async getItemsByTitle(ids: string[]): Promise<LinkedItem[]> {
    const out: LinkedItem[] = [];
    // items(ids:) takes at most 100 ids per call.
    for (let i = 0; i < ids.length; i += 100) {
      const data = await this.transport.request<{
        items: { id: string; name: string; board: { id: string }; column_values: { text: string | null; column: { title: string } }[] }[];
      }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id name board { id } column_values { text column { title } } } }`,
        { ids: ids.slice(i, i + 100) },
      );
      for (const item of data.items) {
        const byTitle = new Map(item.column_values.map((cv) => [bareTitle(cv.column.title), cv.text === null || cv.text === '' ? null : cv.text]));
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
