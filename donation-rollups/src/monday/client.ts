import { fiscalYearFromDate } from '../rollups/compute';

function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface DonationRecord {
  id: string;
  amount: number;
  dateISO: string;
  fiscalYear: number;
  status: string;
}

export interface DonationRollupsMondayClient {
  // Which board an item lives on — used to tell a Donor-owner from an Organization-owner
  // so the right ownerColumnsByBoard set gets written to.
  getItemBoardId(itemId: string): Promise<string | null>;
  // The owner (Donor or Organization) a Donation item's connect column currently points
  // at — null if the Donation is unlinked (nothing to recompute).
  getDonorLinkForDonation(donationItemId: string, donorLinkColumnId: string): Promise<string | null>;
  // Fetches specific Donation items *by id* — not by filtering the board on its Donor
  // column, which Monday's API doesn't support for board_relation columns (confirmed
  // 2026-08-24: items_page_by_column_values rejects it outright). Callers get the id
  // list from the D1 donation_links reverse index (db/links.ts), grouped by which
  // Donations board each id lives on, since column ids differ per board.
  getDonationsByIds(
    itemIds: string[],
    columns: { amount: string; date: string; fiscalYear: string | null; status: string },
  ): Promise<DonationRecord[]>;
  // All items on one Donations board, each with its raw Donor-link value — used only
  // by the one-time bootstrap that populates donation_links, never by normal webhook
  // processing.
  listDonationOwnerLinks(boardId: number, donorLinkColumnId: string): Promise<{ itemId: string; ownerItemId: string | null }[]>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

const MONDAY_API_VERSION = '2026-01';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  error_message?: string;
  status_code?: number;
}

interface ColumnValue { id: string; text: string | null }

export class HttpMondayClient implements DonationRollupsMondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

  async getItemBoardId(itemId: string): Promise<string | null> {
    const data = await this.graphql<{ items: { board: { id: string } }[] }>(
      `query ($itemId: ID!) { items(ids: [$itemId]) { board { id } } }`,
      { itemId },
    );
    return data.items[0]?.board.id ?? null;
  }

  async getDonorLinkForDonation(donationItemId: string, donorLinkColumnId: string): Promise<string | null> {
    const data = await this.graphql<{
      items: { column_values: { id: string; linked_item_ids?: string[] }[] }[];
    }>(
      `query ($itemId: ID!, $columnId: [String!]) {
        items(ids: [$itemId]) {
          column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } }
        }
      }`,
      { itemId: donationItemId, columnId: [donorLinkColumnId] },
    );
    const linked = data.items[0]?.column_values[0]?.linked_item_ids ?? [];
    return linked.length > 0 ? linked[0]! : null;
  }

  async getDonationsByIds(
    itemIds: string[],
    columns: { amount: string; date: string; fiscalYear: string | null; status: string },
  ): Promise<DonationRecord[]> {
    if (itemIds.length === 0) return [];
    const columnIds = [columns.amount, columns.date, columns.status,
      ...(columns.fiscalYear ? [columns.fiscalYear] : [])];
    const donations: DonationRecord[] = [];
    // items(ids:) has a practical ceiling (Monday's complexity budget, not a documented
    // hard limit) — chunk defensively rather than assume any list size is safe.
    for (const chunk of chunksOf(itemIds, 100)) {
      const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids) { id column_values(ids: $columnIds) { id text } }
        }`,
        { ids: chunk, columnIds },
      );
      for (const item of data.items) {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
        const amount = Number(byId.get(columns.amount) ?? '');
        const dateISO = byId.get(columns.date) ?? '';
        const status = byId.get(columns.status) ?? '';
        if (!dateISO || Number.isNaN(amount)) continue; // malformed or deleted item, skip
        // Fall back to deriving from the Date column when this board has no Fiscal
        // Year column yet (or the cell is blank) — see fiscalYearFromDate in
        // rollups/compute.ts.
        const rawFY = columns.fiscalYear ? Number(byId.get(columns.fiscalYear) ?? '') : NaN;
        const fiscalYear = Number.isNaN(rawFY) ? fiscalYearFromDate(dateISO) : rawFY;
        donations.push({ id: item.id, amount, dateISO, fiscalYear, status });
      }
    }
    return donations;
  }

  async listDonationOwnerLinks(
    boardId: number, donorLinkColumnId: string,
  ): Promise<{ itemId: string; ownerItemId: string | null }[]> {
    const out: { itemId: string; ownerItemId: string | null }[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        boards: { items_page: {
          cursor: string | null;
          items: { id: string; column_values: { id: string; linked_item_ids?: string[] }[] }[];
        } }[];
      } = await this.graphql(
        `query ($boardId: [ID!], $columnId: [String!], $cursor: String) {
          boards(ids: $boardId) {
            items_page(limit: 100, cursor: $cursor) {
              cursor
              items { id column_values(ids: $columnId) { id ... on BoardRelationValue { linked_item_ids } } }
            }
          }
        }`,
        { boardId: [boardId], columnId: [donorLinkColumnId], cursor },
      );
      const page = data.boards[0]?.items_page;
      if (page === undefined) break;
      for (const item of page.items) {
        const linked = item.column_values[0]?.linked_item_ids ?? [];
        out.push({ itemId: item.id, ownerItemId: linked.length > 0 ? linked[0]! : null });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return out;
  }

  async changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void> {
    await this.graphql<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
          id
        }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues) },
    );
  }
}
