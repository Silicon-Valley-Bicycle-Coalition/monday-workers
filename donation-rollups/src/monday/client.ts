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
  // Every Donation item linked to one owner, with the four columns the rollup needs.
  getDonationsForOwner(
    donationsBoardId: number, donorLinkColumnId: string, ownerItemId: string,
    columns: { amount: string; date: string; fiscalYear: string; status: string },
  ): Promise<DonationRecord[]>;
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

  async getDonationsForOwner(
    donationsBoardId: number, donorLinkColumnId: string, ownerItemId: string,
    columns: { amount: string; date: string; fiscalYear: string; status: string },
  ): Promise<DonationRecord[]> {
    const columnIds = [columns.amount, columns.date, columns.fiscalYear, columns.status];
    const donations: DonationRecord[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        items_page_by_column_values: {
          cursor: string | null;
          items: { id: string; column_values: ColumnValue[] }[];
        };
      } = await this.graphql(
        `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!, $columnIds: [String!], $cursor: String) {
          items_page_by_column_values(board_id: $boardId, columns: $columns, cursor: $cursor, limit: 100) {
            cursor
            items { id column_values(ids: $columnIds) { id text } }
          }
        }`,
        {
          boardId: donationsBoardId,
          columns: [{ column_id: donorLinkColumnId, column_values: [ownerItemId] }],
          columnIds,
          cursor,
        },
      );
      for (const item of data.items_page_by_column_values.items) {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
        const amount = Number(byId.get(columns.amount) ?? '');
        const fiscalYear = Number(byId.get(columns.fiscalYear) ?? '');
        const dateISO = byId.get(columns.date) ?? '';
        const status = byId.get(columns.status) ?? '';
        if (!dateISO || Number.isNaN(amount) || Number.isNaN(fiscalYear)) continue; // malformed row, skip
        donations.push({ id: item.id, amount, dateISO, fiscalYear, status });
      }
      cursor = data.items_page_by_column_values.cursor;
    } while (cursor !== null);
    return donations;
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
