// Monday reads and writes for zoom-phone-sync, over the shared transport (src/monday/graphql.ts,
// a byte-identical copy: tune it here through constructor options, never by editing it).
import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export const MONDAY_API_URL = 'https://api.monday.com/v2';

export interface PeoplePhone {
  itemId: string;
  // The Phone column's text exactly as Monday holds it; null when empty.
  phone: string | null;
}

export interface TimelineEntry {
  itemId: string;
  customActivityId: string;
  title: string;
  summary: string;
  content: string;
  timestamp: string;
}

export interface PhoneSyncMondayClient {
  /** Every item on the board with the given phone column's text, paged 500 at a time. */
  listPeoplePhones(boardId: number, phoneColumn: string): Promise<PeoplePhone[]>;
}

export interface PhoneLogMondayClient {
  /** Names of the items that still exist, by id. A deleted item is simply absent. */
  itemNames(itemIds: string[]): Promise<Map<string, string>>;
  /** Sets the date column to `date` (YYYY-MM-DD) unless it already holds a later one. Idempotent. */
  advanceDate(boardId: number, itemId: string, columnId: string, date: string): Promise<'set' | 'kept'>;
  /** Creates one timeline entry; returns its id. Not idempotent. */
  createTimelineItem(entry: TimelineEntry): Promise<string>;
}

interface RawItem { id: string; column_values: { id: string; text: string | null }[] }
interface ItemsPage { cursor: string | null; items: RawItem[] }

// The nightly rebuild has no queue behind it: the transport's own retries ride out a blip or the
// per-minute complexity budget, and a longer failure fails the run, leaving yesterday's index in
// place for the next night to replace.
const NIGHTLY_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

// The queue consumer keeps 3 in-process attempts and leaves longer waits to the queue's backoff
// (root CLAUDE.md, "One Monday GraphQL transport").
export const CONSUMER_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 30_000 };

const PAGE = 'cursor items { id column_values(ids: $columnIds) { id text } }';

export class HttpMondayClient implements PhoneSyncMondayClient, PhoneLogMondayClient {
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

  async itemNames(itemIds: string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();
    const data = await this.transport.request<{ items: { id: string; name: string; state?: string | null }[] }>(
      `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id name state } }`,
      { ids: itemIds },
    );
    // `items` returns archived and deleted items too, flagged by state; only active ones get entries.
    return new Map(data.items.filter((i) => i.state === undefined || i.state === null || i.state === 'active').map((i) => [String(i.id), i.name]));
  }

  async advanceDate(boardId: number, itemId: string, columnId: string, date: string): Promise<'set' | 'kept'> {
    const data = await this.transport.request<{ items: { column_values: { text: string | null }[] }[] }>(
      `query ($itemId: ID!, $columnIds: [String!]) { items(ids: [$itemId]) { column_values(ids: $columnIds) { text } } }`,
      { itemId, columnIds: [columnId] },
    );
    const current = (data.items[0]?.column_values[0]?.text ?? '').trim().slice(0, 10);
    if (current !== '' && current >= date) return 'kept';
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      { boardId: String(boardId), itemId, columnId, value: JSON.stringify({ date }) },
    );
    return 'set';
  }

  async createTimelineItem(entry: TimelineEntry): Promise<string> {
    const data = await this.transport.request<{ create_timeline_item: { id: string } }>(
      `mutation ($itemId: ID!, $customActivityId: String!, $title: String!, $summary: String, $content: String, $timestamp: ISO8601DateTime!) {
        create_timeline_item(item_id: $itemId, custom_activity_id: $customActivityId, title: $title, summary: $summary, content: $content, timestamp: $timestamp) { id }
      }`,
      { ...entry },
      // Not idempotent: a create that may have committed throws rather than retrying into a
      // duplicate. The queue's retry is then the rare duplicate, never a missing entry.
      { idempotent: false },
    );
    return String(data.create_timeline_item.id);
  }
}
