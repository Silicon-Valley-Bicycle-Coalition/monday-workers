import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';
import type { MapConfig } from '../config';

export type BoardKey = 'peopleLive' | 'peopleHistorical' | 'organizations';

export interface BoardRecord {
  itemId: string; boardId: number; board: BoardKey; name: string;
  address: string | null; city: string | null; zip: string | null;
  lat: string | null; lng: string | null;
  membershipStatus: string | null; // null on Organizations (column absent) or blank
  doNotSolicit: boolean;           // false when the column is absent
}

// Read-only: the map never writes to Monday.
export interface MapMondayClient {
  readBoard(board: BoardKey, boardId: number, columns: MapConfig['columns']): Promise<BoardRecord[]>;
}

// A cron with no queue behind it: a few in-process attempts ride out a Monday blip, and anything
// longer fails the run for the next one to retry.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

interface RawItem { id: string; name: string; column_values: { id: string; text: string | null }[] }
interface Page { cursor: string | null; items: RawItem[] }

const REQUIRED = ['address', 'city', 'zip', 'lat', 'lng'] as const;
const OPTIONAL = ['membershipStatus', 'doNotSolicit'] as const;

export class HttpMondayClient implements MapMondayClient {
  private readonly transport: MondayGraphQL;

  constructor(apiUrl: string, apiToken: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  async readBoard(board: BoardKey, boardId: number, columns: MapConfig['columns']): Promise<BoardRecord[]> {
    const meta = await this.transport.request<{ boards: { columns: { id: string; title: string }[] }[] }>(
      `query ($boardId: [ID!]) { boards(ids: $boardId) { id columns { id title } } }`,
      { boardId: [String(boardId)] },
    );
    const boardColumns = meta.boards[0]?.columns;
    if (!boardColumns) throw new Error(`member-map: board ${boardId} not found`);
    const idByTitle = new Map(boardColumns.map((c) => [bareTitle(c.title), c.id]));

    const ids: Partial<Record<keyof MapConfig['columns'], string>> = {};
    for (const key of REQUIRED) {
      const id = idByTitle.get(columns[key]);
      if (id === undefined) throw new Error(`member-map: board ${boardId} has no "${columns[key]}" column`);
      ids[key] = id;
    }
    for (const key of OPTIONAL) {
      const id = idByTitle.get(columns[key]);
      if (id !== undefined) ids[key] = id;
    }
    const columnIds = Object.values(ids);

    const fields = `cursor items { id name column_values(ids: $columnIds) { id text } }`;
    const first = await this.transport.request<{ boards: { items_page: Page }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!]) { boards(ids: $boardId) { items_page(limit: 500) { ${fields} } } }`,
      { boardId: [String(boardId)], columnIds },
    );
    let page: Page | undefined = first.boards[0]?.items_page;
    const records: BoardRecord[] = [];
    while (page) {
      for (const raw of page.items) records.push(toRecord(raw, board, boardId, ids));
      if (!page.cursor) break;
      const next: { next_items_page: Page } = await this.transport.request(
        `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${fields} } }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
    }
    return records;
  }
}

function toRecord(raw: RawItem, board: BoardKey, boardId: number, ids: Partial<Record<keyof MapConfig['columns'], string>>): BoardRecord {
  const text = new Map(raw.column_values.map((cv) => [cv.id, cv.text === null || cv.text === '' ? null : cv.text]));
  const get = (key: keyof MapConfig['columns']): string | null => {
    const id = ids[key];
    return id === undefined ? null : (text.get(id) ?? null);
  };
  return {
    itemId: raw.id, boardId, board, name: raw.name,
    address: get('address'), city: get('city'), zip: get('zip'), lat: get('lat'), lng: get('lng'),
    membershipStatus: get('membershipStatus'),
    doNotSolicit: get('doNotSolicit') === 'v',
  };
}
