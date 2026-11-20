// Monday reads and writes for zoom-phone-sync, over the shared transport (src/monday/graphql.ts,
// a byte-identical copy: tune it here through constructor options, never by editing it).
import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export const MONDAY_API_URL = 'https://api.monday.com/v2';

export interface PeoplePhone {
  itemId: string;
  // The Phone column's text exactly as Monday holds it; null when empty.
  phone: string | null;
}

export interface PhoneSyncMondayClient {
  /** Every item on the board with the given phone column's text, paged 500 at a time. */
  listPeoplePhones(boardId: number, phoneColumn: string): Promise<PeoplePhone[]>;
}

interface RawItem { id: string; column_values: { id: string; text: string | null }[] }
interface ItemsPage { cursor: string | null; items: RawItem[] }

// The nightly rebuild has no queue behind it: the transport's own retries ride out a blip or the
// per-minute complexity budget, and a longer failure fails the run, leaving yesterday's index in
// place for the next night to replace.
const NIGHTLY_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

const PAGE = 'cursor items { id column_values(ids: $columnIds) { id text } }';

export class HttpMondayClient implements PhoneSyncMondayClient {
  private readonly transport: MondayGraphQL;

  constructor(token: string | TokenProvider, options: MondayGraphQLOptions = {}, apiUrl = MONDAY_API_URL) {
    this.transport = new MondayGraphQL(apiUrl, token, { ...NIGHTLY_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  async listPeoplePhones(boardId: number, phoneColumn: string): Promise<PeoplePhone[]> {
    const columnIds = [phoneColumn];
    const out: PeoplePhone[] = [];
    const collect = (page: ItemsPage) => {
      for (const item of page.items) {
        const text = item.column_values.find((cv) => cv.id === phoneColumn)?.text ?? null;
        out.push({ itemId: String(item.id), phone: text === null || text.trim() === '' ? null : text });
      }
    };

    const first = await this.transport.request<{ boards: { items_page: ItemsPage }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!]) { boards(ids: $boardId) { items_page(limit: 500) { ${PAGE} } } }`,
      { boardId: [String(boardId)], columnIds },
    );
    const board = first.boards[0];
    // A missing board must fail the run: an empty list would wipe the index.
    if (board === undefined) throw new Error(`monday: People board ${boardId} not found or not visible`);
    let page = board.items_page;
    collect(page);
    while (page.cursor !== null) {
      const next = await this.transport.request<{ next_items_page: ItemsPage }>(
        `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: 500, cursor: $cursor) { ${PAGE} } }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
      collect(page);
    }
    return out;
  }
}
