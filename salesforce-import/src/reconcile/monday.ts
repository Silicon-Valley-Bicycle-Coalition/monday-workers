import type { MondayClient } from '../load/monday.js';
import { SF_ID_COLUMN } from '../load/lookup.js';

/** A Monday item as read back for reconciliation; `values` is keyed by column TITLE. */
export interface ReadItem { id: string; state: string; boardId: string; values: Record<string, string> }

/**
 * The read-only Monday surface reconcile needs. Nothing here writes. Kept as an interface so
 * the comparison logic is testable without faking GraphQL.
 */
export interface MondayReader {
  /** Column title → id for a board. */
  columns(boardId: number): Promise<Map<string, string>>;
  /** Every ACTIVE item on a board (Monday's items_page can't list archived ones). */
  scan(boardId: number, cols: Record<string, string>): Promise<ReadItem[]>;
  /** Items by id in any state — the only way Monday's API returns an archived item. Deleted or
   * unknown ids are simply absent from the result. */
  byIds(ids: readonly string[], cols: Record<string, string>): Promise<ReadItem[]>;
}

const DEBUG_COLUMN = 'Salesforce Debug';
const SF_ID_IN_DEBUG = /SF ID: (\S+)/;

/** Columns a board offers for identifying an item's Salesforce record, in preference order. */
export const SF_ID_SOURCES = [SF_ID_COLUMN, DEBUG_COLUMN] as const;

/**
 * The Salesforce Id an item was imported from: the dedicated column where the board has it,
 * else the `SF ID: …` prefix of Salesforce Debug (boards loaded before that column existed).
 */
export function sfIdOf(item: ReadItem): string | null {
  const direct = item.values[SF_ID_COLUMN]?.trim();
  if (direct) return direct;
  return SF_ID_IN_DEBUG.exec(item.values[DEBUG_COLUMN] ?? '')?.[1] ?? null;
}

const PAGE = 500;
const BY_ID_PAGE = 100; // items(ids:) returns at most 100 per call

interface RawItem { id: string; state?: string; board?: { id: string } | null; column_values: { id: string; text: string | null }[] }
interface RawPage { cursor: string | null; items: RawItem[] }

export class GraphqlMondayReader implements MondayReader {
  constructor(private client: MondayClient, private opts: { concurrency?: number } = {}) {}

  async columns(boardId: number): Promise<Map<string, string>> {
    const res = await this.client.gql<{ boards: { columns: { id: string; title: string }[] }[] }>(
      'query ($ids: [ID!]) { boards (ids: $ids) { columns { id title } } }', { ids: [String(boardId)] });
    const board = res.boards[0];
    if (!board) throw new Error(`reconcile: board ${boardId} not found (or not visible to this token)`);
    return new Map(board.columns.map((c) => [c.title, c.id]));
  }

  async scan(boardId: number, cols: Record<string, string>): Promise<ReadItem[]> {
    const out: ReadItem[] = [];
    const ids = Object.values(cols);
    const fields = 'cursor items { id state board { id } column_values (ids: $cols) { id text } }';
    const first = await this.client.gql<{ boards: { items_page?: RawPage }[] }>(
      `query ($ids: [ID!], $cols: [String!], $limit: Int!) { boards (ids: $ids) {
         items_page (limit: $limit) { ${fields} } } }`,
      { ids: [String(boardId)], cols: ids, limit: PAGE });
    let cursor = this.take(first.boards[0]?.items_page, cols, out);
    while (cursor) {
      const next = await this.client.gql<{ next_items_page: RawPage }>(
        `query ($cursor: String!, $cols: [String!], $limit: Int!) {
           next_items_page (cursor: $cursor, limit: $limit) { ${fields} } }`,
        { cursor, cols: ids, limit: PAGE });
      cursor = this.take(next.next_items_page, cols, out);
    }
    return out;
  }

  async byIds(ids: readonly string[], cols: Record<string, string>): Promise<ReadItem[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += BY_ID_PAGE) chunks.push(ids.slice(i, i + BY_ID_PAGE));
    const out: ReadItem[] = [];
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const res = await this.client.gql<{ items: RawItem[] }>(
          `query ($ids: [ID!], $cols: [String!], $limit: Int!) {
             items (ids: $ids, limit: $limit, exclude_nonactive: false) {
               id state board { id } column_values (ids: $cols) { id text } } }`,
          { ids: chunk, cols: Object.values(cols), limit: BY_ID_PAGE });
        this.take({ cursor: null, items: res.items }, cols, out);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency ?? 4) }, worker));
    return out;
  }

  private take(page: RawPage | undefined, cols: Record<string, string>, out: ReadItem[]): string | null {
    const titleOf = new Map(Object.entries(cols).map(([title, id]) => [id, title]));
    for (const item of page?.items ?? []) {
      const values: Record<string, string> = {};
      for (const cv of item.column_values) {
        const title = titleOf.get(cv.id);
        if (title) values[title] = cv.text ?? '';
      }
      out.push({ id: item.id, state: item.state ?? 'active', boardId: item.board?.id ?? '', values });
    }
    return page?.cursor ?? null;
  }
}
