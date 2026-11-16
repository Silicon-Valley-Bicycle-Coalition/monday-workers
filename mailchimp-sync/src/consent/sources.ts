// The consent sync's reads and writes: every member's status from Mailchimp, the address and
// consent columns from Monday, and the consent writes back. Shared by the hourly run (run.ts) and
// the operator script scripts/consent-plan.mjs, which loads this file through Node's type
// stripping — so relative imports stay `import type` only.
import type { ConsentBoard } from '../types';
import type { ConsentItem, ConsentWrite } from './plan';

// A pass returned fewer members than Mailchimp said it holds (one added or removed mid-paging, or
// a truncated page). The run then writes nothing: a missing member would read as "Not in
// Mailchimp", which may be emailed.
export class ConsentShortReadError extends Error {}

export interface MailchimpListOptions {
  fetchFn: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  audienceId: string;
  pageSize?: number;
}

const REQUEST_TIMEOUT_MS = 20_000;
const FIELDS = 'total_items,members.email_address,members.status';

/**
 * Every member of the audience, normalized address → status. Two passes: Mailchimp's member list
 * leaves archived members out unless asked for them, and an archived address must read as an
 * opt-out, not as absent.
 */
export async function readMailchimpStatuses(opts: MailchimpListOptions): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  for (const archived of [false, true]) await readPass(opts, archived, statuses);
  return statuses;
}

async function readPass(opts: MailchimpListOptions, archived: boolean, into: Map<string, string>): Promise<void> {
  const pageSize = opts.pageSize ?? 1000;
  const auth = `Basic ${btoa(`anystring:${opts.apiKey}`)}`;
  let offset = 0;
  let total: number | null = null;
  let read = 0;
  do {
    const params = new URLSearchParams({ count: String(pageSize), offset: String(offset), fields: FIELDS });
    if (archived) params.set('status', 'archived');
    const response = await opts.fetchFn(`${opts.apiBaseUrl}/lists/${opts.audienceId}/members?${params}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`mailchimp list members${archived ? ' (archived)' : ''}: HTTP ${response.status} at offset ${offset}`);
    }
    const page = (await response.json()) as { total_items: number; members: { email_address: string; status: string }[] };
    // Offset paging shifts when a member is archived or deleted mid-read, skipping one while the
    // final count can still match. A total that moves between pages is that shift: start over
    // next hour rather than plan on a read with a member missing.
    if (total !== null && page.total_items !== total) {
      throw new ConsentShortReadError(`mailchimp list members${archived ? ' (archived)' : ''}: total changed from ${total} to ${page.total_items} while paging`);
    }
    total = page.total_items;
    for (const m of page.members) into.set(m.email_address.trim().toLowerCase(), m.status);
    read += page.members.length;
    if (page.members.length === 0) break;
    offset += pageSize;
  } while (offset < (total ?? 0));
  if (read !== total) {
    throw new ConsentShortReadError(`mailchimp list members${archived ? ' (archived)' : ''}: read ${read} of ${total}`);
  }
}

// The transport's request (src/monday/graphql.ts MondayGraphQL.request), passed in so this file
// needs no value import.
export type GraphQLRequest = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

export interface ConsentMonday {
  readBoard(board: ConsentBoard): Promise<ConsentItem[]>;
  writeConsent(writes: readonly ConsentWrite[]): Promise<{ written: number; failedItemIds: string[] }>;
}

const PAGE = 500;
const ITEMS_PER_MUTATION = 25;
const ITEM_FIELDS = 'cursor items { id column_values(ids: $columnIds) { id text ... on EmailValue { email } } }';

interface ColumnValue { id: string; text: string | null; email?: string | null }
interface ItemsPage { cursor: string | null; items: { id: string; column_values: ColumnValue[] }[] }

export interface ConsentMondayOptions {
  // True for a Monday outage (429, 5xx, timeout, spent budget): writing stops for the run, since
  // every further request would fail the same way and the item-by-item fallback could outlast
  // the cron's wall clock. index.ts passes the outage breaker's isMondayOutage.
  isOutage?: (err: unknown) => boolean;
}

export function createConsentMonday(request: GraphQLRequest, options: ConsentMondayOptions = {}): ConsentMonday {
  const isOutage = options.isOutage ?? (() => false);
  async function writeChunk(chunk: readonly ConsentWrite[]): Promise<void> {
    const vars: Record<string, unknown> = {};
    const decls: string[] = [];
    const fields: string[] = [];
    chunk.forEach((w, n) => {
      vars[`b${n}`] = w.boardId;
      vars[`i${n}`] = w.itemId;
      // A status label by its text.
      vars[`v${n}`] = JSON.stringify(Object.fromEntries(Object.entries(w.columnValues).map(([col, label]) => [col, { label }])));
      decls.push(`$b${n}: ID!, $i${n}: ID!, $v${n}: JSON!`);
      fields.push(`w${n}: change_multiple_column_values(board_id: $b${n}, item_id: $i${n}, column_values: $v${n}) { id }`);
    });
    await request(`mutation (${decls.join(', ')}) { ${fields.join(' ')} }`, vars);
  }

  return {
    async readBoard(board) {
      const columnIds = board.pairs.flatMap((p) => [p.emailColumn, p.consentColumn]);
      const first = await request<{ boards: { items_page: ItemsPage }[] }>(
        `query ($boardId: ID!, $columnIds: [String!]) { boards(ids: [$boardId]) { items_page(limit: ${PAGE}) { ${ITEM_FIELDS} } } }`,
        { boardId: board.boardId, columnIds },
      );
      const firstPage = first.boards?.[0]?.items_page;
      if (firstPage === undefined) throw new Error(`consent: board ${board.boardId} (${board.name}) is not readable`);
      const items: ConsentItem[] = [];
      let page: ItemsPage = firstPage;
      for (;;) {
        for (const item of page.items) {
          const values: Record<string, string> = {};
          for (const cv of item.column_values) values[cv.id] = (cv.email || cv.text || '').trim();
          for (const id of columnIds) {
            // A mistyped config id comes back as no column value at all; planning on it would
            // write to a column that doesn't exist.
            if (!(id in values)) throw new Error(`consent: board ${board.boardId} (${board.name}) has no column "${id}"`);
          }
          items.push({ itemId: item.id, values });
        }
        if (page.cursor === null) break;
        const next = await request<{ next_items_page: ItemsPage }>(
          `query ($cursor: String!, $columnIds: [String!]) { next_items_page(limit: ${PAGE}, cursor: $cursor) { ${ITEM_FIELDS} } }`,
          { cursor: page.cursor, columnIds },
        );
        page = next.next_items_page;
      }
      return items;
    },

    async writeConsent(writes) {
      let written = 0;
      const failedItemIds: string[] = [];
      const giveUpFrom = (index: number) => {
        for (const w of writes.slice(index)) failedItemIds.push(w.itemId);
      };
      for (let i = 0; i < writes.length; i += ITEMS_PER_MUTATION) {
        const chunk = writes.slice(i, i + ITEMS_PER_MUTATION);
        try {
          await writeChunk(chunk);
          written += chunk.length;
        } catch (err) {
          if (isOutage(err)) {
            giveUpFrom(i);
            return { written, failedItemIds };
          }
          // One bad item fails the whole aliased request; redo the chunk one item at a time so
          // only that item is left for the next hour.
          for (let j = 0; j < chunk.length; j += 1) {
            try {
              await writeChunk([chunk[j]!]);
              written += 1;
            } catch (itemErr) {
              if (isOutage(itemErr)) {
                giveUpFrom(i + j);
                return { written, failedItemIds };
              }
              failedItemIds.push(chunk[j]!.itemId);
            }
          }
        }
      }
      return { written, failedItemIds };
    },
  };
}
