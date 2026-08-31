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
  giftType?: string | null; // present when the board's Gift Type column is configured
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
    columns: { amount: string; date: string; fiscalYear: string | null; status: string; giftType?: string | null },
  ): Promise<DonationRecord[]>;
  // Rewrites an owner item's description with the markdown gift-history projection.
  setItemDescription(itemId: string, markdown: string): Promise<void>;
  // All items on one Donations board, each with its raw Donor-link value — used only
  // by the one-time bootstrap that populates donation_links, never by normal webhook
  // processing.
  listDonationOwnerLinks(boardId: number, donorLinkColumnId: string): Promise<{ itemId: string; ownerItemId: string | null }[]>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
  // Posts an update on an item — the consumer's alert path for oversized gift-ledger
  // projections (same Monday alert item the custodian duties use).
  createUpdate(itemId: number, body: string): Promise<void>;
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

  private async graphql<T>(query: string, variables: Record<string, unknown>, apiVersion = MONDAY_API_VERSION): Promise<T> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
        'API-Version': apiVersion,
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
    columns: { amount: string; date: string; fiscalYear: string | null; status: string; giftType?: string | null },
  ): Promise<DonationRecord[]> {
    if (itemIds.length === 0) return [];
    const columnIds = [columns.amount, columns.date, columns.status,
      ...(columns.fiscalYear ? [columns.fiscalYear] : []),
      ...(columns.giftType ? [columns.giftType] : [])];
    const donations: DonationRecord[] = [];
    // items(ids:) has a practical ceiling (Monday's complexity budget, not a documented
    // hard limit) — chunk defensively rather than assume any list size is safe.
    for (const chunk of chunksOf(itemIds, 100)) {
      // limit: 100 is load-bearing — items(ids:) silently returns only 25 items by default
      // even when handed 100 ids (verified live 2026-08-31; it surfaced as 75% of owners
      // "missing" in reconciliation and would have silently under-rolled any donor with
      // more than 25 gifts on one board).
      const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: 100) { id column_values(ids: $columnIds) { id text } }
        }`,
        { ids: chunk, columnIds },
      );
      for (const item of data.items) {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
        // A blank Amount must be treated as malformed like a blank Date — Number('') is 0,
        // not NaN, and letting it through would refresh the ledger's real (bootstrap-loaded)
        // amount down to $0 on the next recompute (refreshFacts upserts unconditionally).
        const amountText = (byId.get(columns.amount) ?? '').trim();
        const amount = Number(amountText);
        const dateISO = byId.get(columns.date) ?? '';
        const status = byId.get(columns.status) ?? '';
        if (!dateISO || amountText === '' || Number.isNaN(amount)) continue; // malformed or deleted item, skip
        // Fall back to deriving from the Date column when this board has no Fiscal
        // Year column yet (or the cell is blank) — see fiscalYearFromDate in
        // rollups/compute.ts.
        const rawFY = columns.fiscalYear ? Number(byId.get(columns.fiscalYear) ?? '') : NaN;
        const fiscalYear = Number.isNaN(rawFY) ? fiscalYearFromDate(dateISO) : rawFY;
        const giftType = columns.giftType ? (byId.get(columns.giftType) || null) : undefined;
        donations.push({ id: item.id, amount, dateISO, fiscalYear, status, giftType });
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

  async setItemDescription(itemId: string, markdown: string): Promise<void> {
    // set_item_description_content requires API 2026-04+ (the rest of this client pins
    // 2026-01) — override the version for just this call.
    await this.graphql<{ set_item_description_content: { success: boolean } }>(
      `mutation ($itemId: ID!, $markdown: String!) {
        set_item_description_content(item_id: $itemId, markdown: $markdown) { success }
      }`,
      { itemId, markdown },
      '2026-04',
    );
  }

  // --- Custodian surface (docs/20 §5.3) ---

  async createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string> {
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
      }`,
      { boardId: String(boardId), itemName, columnValues: JSON.stringify(columnValues) },
    );
    return data.create_item.id;
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.graphql<{ archive_item: { id: string } }>(
      `mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
      { itemId },
    );
  }

  async listWorkspaceBoards(workspaceId: number): Promise<{ id: string; name: string; itemsCount: number; itemsLimit: number | null }[]> {
    const data = await this.graphql<{ boards: { id: string; name: string; items_count: number; items_limit: number | null }[] }>(
      `query ($workspaceId: [ID!]) {
        boards(workspace_ids: $workspaceId, limit: 100) { id name items_count items_limit }
      }`,
      { workspaceId: [workspaceId] },
    );
    return data.boards.map((b) => ({ id: b.id, name: b.name, itemsCount: b.items_count, itemsLimit: b.items_limit }));
  }

  async getItemsColumnsText(itemIds: string[], columnIds: string[]): Promise<Map<string, Map<string, string | null>>> {
    const out = new Map<string, Map<string, string | null>>();
    // 100 is a hard Monday API limit on items(ids:) — "Argument 'ids' exceeding the 100
    // limit", verified live 2026-08-31 — so large reads can't be squeezed into fewer
    // subrequests here; callers with big id sets must slice themselves (see runReconcile).
    // Multiple columns per item DO share one subrequest, which is why reconciliation
    // reads Lifetime Giving and the Gift Ledger JSON together instead of twice.
    for (const chunk of chunksOf(itemIds, 100)) {
      // limit: 100 — same silent-25 default as getDonationsByIds above.
      const data = await this.graphql<{ items: { id: string; column_values: ColumnValue[] }[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: 100) { id column_values(ids: $columnIds) { id text } }
        }`,
        { ids: chunk, columnIds },
      );
      for (const item of data.items) {
        const cols = new Map<string, string | null>(columnIds.map((id) => [id, null]));
        for (const cv of item.column_values) {
          cols.set(cv.id, cv.text === null || cv.text === '' ? null : cv.text);
        }
        out.set(item.id, cols);
      }
    }
    return out;
  }

  async createUpdate(itemId: number, body: string): Promise<void> {
    await this.graphql<{ create_update: { id: string } }>(
      `mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(itemId), body },
    );
  }
}
