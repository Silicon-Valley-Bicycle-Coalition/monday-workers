import type {
  ChangeRequestColumns,
  DiscountOrganization,
  DonationRecord,
  DonorContactInfo,
  DonorMatch,
  DonorPortalData,
  MondayColumns,
  VolunteerShift,
} from '../types';

interface MondayColumnValue {
  id: string;
  text: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  column_values?: MondayColumnValue[];
}

function columnText(item: MondayItem, columnId: string): string {
  return (item.column_values ?? []).find((c) => c.id === columnId)?.text ?? '';
}

export interface MondayClient {
  findDonorsByEmail(email: string): Promise<DonorMatch[]>;
  getDonorPortalData(donorItemId: string): Promise<DonorPortalData>;
  getDiscountOrganizations(): Promise<DiscountOrganization[]>;
  getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]>;
  getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo>;
  createChangeRequestItem(params: {
    boardId: number;
    columns: ChangeRequestColumns;
    itemName: string;
    donorItemId: string;
    fieldLabel: string;
    oldValue: string;
    newValue: string;
    submittedAtISO: string;
  }): Promise<void>;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private columns: MondayColumns,
    private donorsBoardId: number,
    private donationsBoardId: number,
    private organizationsBoardId: number,
    private volunteersBoardId: number,
    private fetchFn: typeof fetch = fetch
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) {
      throw new Error(`monday: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data as T;
  }

  async findDonorsByEmail(email: string): Promise<DonorMatch[]> {
    // NOTE: `email` is attacker-controlled (it comes straight from the POST /login body), so it
    // must never be interpolated into the query string — it's passed as a proper GraphQL
    // variable ($email) instead, with only `compare_value: [$email]` referencing it. This
    // variable-inside-query_params shape is written from current Monday API v2 knowledge but not
    // verified against a live account — verify before deploy (same caveat as the two NOTE
    // comments below on query_params.rules shapes). column_id stays interpolated because it's a
    // trusted config value, never attacker input.
    // preferredLanguage is a gated/optional column, same convention as membershipExpiry in
    // getDonorPortalData below: only request it once it's been configured with a real column id,
    // so the literal placeholder never ships to Monday's API.
    const languageFragment =
      this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID'
        ? `column_values(ids: ["${this.columns.preferredLanguage}"]) { id text }`
        : '';
    const query = `
      query ($boardId: ID!, $email: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 25,
            query_params: {
              rules: [{ column_id: "${this.columns.donorEmail}", compare_value: [$email], operator: any_of }]
            }
          ) {
            items { id name ${languageFragment} }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: this.donorsBoardId,
      email,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      preferredLanguage: columnText(item, this.columns.preferredLanguage),
    }));
  }

  async getDonorPortalData(donorItemId: string): Promise<DonorPortalData> {
    // getDonorPortalData backs /portal and /portal/letters, which run for EVERY donor
    // regardless of whether the (gated, placeholder-tolerant) membership-card feature is
    // enabled. membershipExpiry only matters to that gated feature, so it's deliberately left
    // as the placeholder id until an operator fills it in — including it in this always-on
    // query unconditionally would ship the literal placeholder string to Monday's API on every
    // portal request. Only request it once it's been configured with a real column id.
    const donorColumnIds = [this.columns.membershipStatus, this.columns.membershipTier, this.columns.dollarDonated];
    if (this.columns.membershipExpiry !== 'REPLACE_WITH_COLUMN_ID') {
      donorColumnIds.push(this.columns.membershipExpiry);
    }
    const donorQuery = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ${JSON.stringify(donorColumnIds)}) {
            id
            text
          }
        }
      }
    `;
    const donorData = await this.request<{ items: MondayItem[] }>(donorQuery, { itemId: donorItemId });
    const donorItem = donorData.items[0];
    if (!donorItem) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }

    const donations = await this.getDonationsForDonor(donorItemId);

    return {
      id: donorItem.id,
      name: donorItem.name,
      membershipStatus: columnText(donorItem, this.columns.membershipStatus),
      membershipTier: columnText(donorItem, this.columns.membershipTier),
      totalDonated: columnText(donorItem, this.columns.dollarDonated),
      donations,
      membershipExpiry: columnText(donorItem, this.columns.membershipExpiry),
    };
  }

  private async getDonationsForDonor(donorItemId: string): Promise<DonationRecord[]> {
    const columnIds = JSON.stringify([this.columns.donationAmount, this.columns.donationDate, this.columns.donationDescription]);
    // NOTE: the query_params.rules shape for filtering by a connect-board column's linked item
    // id (donationDonorLink here) is written from current Monday API v2 knowledge but not
    // verified against a live account — verify against a real Donations board before deploy
    // (same caveat already flagged in membership-reminders/src/monday.ts). donorItemId isn't
    // attacker-reachable today (it's derived from the session, never client-supplied), but it's
    // passed as a $donorItemId GraphQL variable rather than interpolated, as defense-in-depth
    // and for consistency with findDonorsByEmail above.
    const firstPageQuery = `
      query ($boardId: ID!, $donorItemId: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.donationDonorLink}", compare_value: [$donorItemId], operator: any_of }]
            }
          ) {
            cursor
            items { id column_values(ids: ${columnIds}) { id text } }
          }
        }
      }
    `;
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          items { id column_values(ids: ${columnIds}) { id text } }
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId: this.donationsBoardId, donorItemId });
    const firstPage = firstData.boards[0]?.items_page;
    const allItems: MondayItem[] = [...(firstPage?.items ?? [])];
    let cursor = firstPage?.cursor ?? null;

    while (cursor) {
      const nextData = await this.request<{
        next_items_page: { cursor: string | null; items: MondayItem[] };
      }>(nextPageQuery, { cursor });
      allItems.push(...nextData.next_items_page.items);
      cursor = nextData.next_items_page.cursor;
    }

    return allItems.map((item) => ({
      amount: columnText(item, this.columns.donationAmount),
      date: columnText(item, this.columns.donationDate),
      description: columnText(item, this.columns.donationDescription),
    }));
  }

  async getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]> {
    // Same items_page/next_items_page pagination and connect-board filter shape as
    // getDonationsForDonor above — including its NOTE about the query_params.rules shape being
    // unverified against a live account, and donorItemId traveling as a GraphQL variable as
    // defense-in-depth. Only called when volunteerHistoryEnabled(config) is true, so
    // volunteersBoardId and the volunteer column ids are real (non-placeholder) here.
    const columnIds = JSON.stringify([
      this.columns.volunteerHours,
      this.columns.volunteerDate,
      this.columns.volunteerJob,
      this.columns.volunteerStatus,
    ]);
    const firstPageQuery = `
      query ($boardId: ID!, $donorItemId: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.volunteerDonorLink}", compare_value: [$donorItemId], operator: any_of }]
            }
          ) {
            cursor
            items { id column_values(ids: ${columnIds}) { id text } }
          }
        }
      }
    `;
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          items { id column_values(ids: ${columnIds}) { id text } }
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId: this.volunteersBoardId, donorItemId });
    const firstPage = firstData.boards[0]?.items_page;
    const allItems: MondayItem[] = [...(firstPage?.items ?? [])];
    let cursor = firstPage?.cursor ?? null;

    while (cursor) {
      const nextData = await this.request<{
        next_items_page: { cursor: string | null; items: MondayItem[] };
      }>(nextPageQuery, { cursor });
      allItems.push(...nextData.next_items_page.items);
      cursor = nextData.next_items_page.cursor;
    }

    return allItems.map((item) => ({
      hours: columnText(item, this.columns.volunteerHours),
      date: columnText(item, this.columns.volunteerDate),
      job: columnText(item, this.columns.volunteerJob),
      status: columnText(item, this.columns.volunteerStatus),
    }));
  }

  async getDiscountOrganizations(): Promise<DiscountOrganization[]> {
    // NOTE: the query_params.rules shape for filtering by a checkbox column's boolean value
    // (discountActive here) is written from current Monday API v2 knowledge but not verified
    // against a live account — verify against a real Organizations board before deploy (same
    // caveat already flagged in membership-reminders/src/monday.ts).
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.discountActive}", compare_value: ["true"], operator: any_of }]
            }
          ) {
            cursor
            items { id name column_values(ids: ["${this.columns.discountOffered}"]) { id text } }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { cursor: string | null; items: MondayItem[] } }[] }>(
      query,
      { boardId: this.organizationsBoardId }
    );
    const items = data.boards[0]?.items_page.items ?? [];
    return items.map((item) => ({
      name: item.name,
      discountOffered: columnText(item, this.columns.discountOffered),
    }));
  }

  async getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo> {
    // preferredLanguage is a gated/optional column like membershipExpiry — join it onto the
    // otherwise-fixed donorEmail/donorAddress/donorPhone list only once configured, rather than
    // shipping the literal placeholder to Monday's API.
    const columnIds = [this.columns.donorEmail, this.columns.donorAddress, this.columns.donorPhone];
    if (this.columns.preferredLanguage !== 'REPLACE_WITH_COLUMN_ID') {
      columnIds.push(this.columns.preferredLanguage);
    }
    const query = `
      query ($itemId: ID!) {
        items(ids: [$itemId]) {
          id
          name
          column_values(ids: ${JSON.stringify(columnIds)}) {
            id
            text
          }
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemId: donorItemId });
    const item = data.items[0];
    if (!item) {
      throw new Error(`monday: donor item "${donorItemId}" not found`);
    }
    return {
      id: item.id,
      name: item.name,
      email: columnText(item, this.columns.donorEmail),
      address: columnText(item, this.columns.donorAddress),
      phone: columnText(item, this.columns.donorPhone),
      preferredLanguage: columnText(item, this.columns.preferredLanguage),
    };
  }

  async createChangeRequestItem(params: {
    boardId: number;
    columns: ChangeRequestColumns;
    itemName: string;
    donorItemId: string;
    fieldLabel: string;
    oldValue: string;
    newValue: string;
    submittedAtISO: string;
  }): Promise<void> {
    // NOTE: the column_values shapes below (connect-boards { item_ids }, date { date, time })
    // are written from current Monday API v2 knowledge but not verified against a live account —
    // verify against the real Change Requests board before deploy (same caveat as the read-side
    // NOTEs above). All user-sourced values travel as GraphQL variables.
    const mutation = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
          id
        }
      }
    `;
    const columnValues: Record<string, unknown> = {
      [params.columns.donorLink]: { item_ids: [Number(params.donorItemId)] },
      [params.columns.field]: params.fieldLabel,
      [params.columns.oldValue]: params.oldValue,
      [params.columns.newValue]: params.newValue,
      [params.columns.submittedAt]: {
        date: params.submittedAtISO.slice(0, 10),
        time: params.submittedAtISO.slice(11, 19),
      },
    };
    await this.request<{ create_item: { id: string } }>(mutation, {
      boardId: params.boardId,
      itemName: params.itemName,
      columnValues: JSON.stringify(columnValues),
    });
  }
}
