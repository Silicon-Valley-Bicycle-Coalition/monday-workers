import type {
  ChangeRequestColumns,
  DiscountOrganization,
  DonationRecord,
  DonorContactInfo,
  DonorMatch,
  DonorPortalData,
  EventRegistrationColumns,
  EventRegistrationRecord,
  LetterCronColumns,
  LetterSettings,
  MondayColumns,
  PledgeColumns,
  PledgeRecord,
  VolunteerShift,
} from '../types';
import type { Locale } from '../i18n/locales';

interface MondayColumnValue {
  id: string;
  text: string | null;
  checked?: boolean; // CheckboxValue fragment
  linked_item_ids?: string[]; // BoardRelationValue fragment
}

interface MondayItem {
  id: string;
  name: string;
  column_values?: MondayColumnValue[];
}

function columnText(item: MondayItem, columnId: string): string {
  return (item.column_values ?? []).find((c) => c.id === columnId)?.text ?? '';
}

// Monday checkbox columns render as text "v" when checked and "" (or an absent column_value)
// when not. An unconfigured column can't be read at all, so it maps to null, not false.
function checkboxState(item: MondayItem, columnId: string): boolean | null {
  if (columnId === 'REPLACE_WITH_COLUMN_ID') return null;
  return columnText(item, columnId) !== '';
}

export interface MondayClient {
  findDonorsByEmail(email: string): Promise<DonorMatch[]>;
  getDonorPortalData(donorItemId: string): Promise<DonorPortalData>;
  getDiscountOrganizations(): Promise<DiscountOrganization[]>;
  getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]>;
  getDonorContactInfo(donorItemId: string): Promise<DonorContactInfo>;
  // Lightweight id+name lookup (one query for all ids) — exists so the pledges page can label
  // per-donor sections without getDonorPortalData's full donation-history fetch per donor.
  getDonorNames(donorItemIds: string[]): Promise<{ id: string; name: string }[]>;
  getPledgesForDonor(donorItemId: string): Promise<PledgeRecord[]>;
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
  getEventRegistrationsForDonor(params: {
    donorItemId: string;
    boardId: number;
    columns: EventRegistrationColumns;
    eventDateColumnId: string;
  }): Promise<EventRegistrationRecord[]>;
  getLetterSettings(params: { boardId: number; columns: LetterCronColumns }): Promise<LetterSettings | null>;
  listDonorIdsWithDonationsInYear(year: number): Promise<string[]>;
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private columns: MondayColumns,
    private donorsBoardId: number,
    private donationsBoardId: number,
    private organizationsBoardId: number,
    // null until an operator configures pledges.boardId + columns (the feature is gated on
    // pledgesEnabled, so routes never call getPledgesForDonor while this is null).
    private pledges: { boardId: number; columns: PledgeColumns } | null = null,
    // null until an operator configures monday.volunteersBoardId — getVolunteerShiftsForDonor
    // throws its own config error on null rather than querying a sentinel board id.
    private volunteersBoardId: number | null = null,
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

  // Shared by getDonationsForDonor, getPledgesForDonor, and getVolunteerShiftsForDonor: every item on a board whose
  // connect-board column links to donorItemId, following the cursor across pages.
  // NOTE: the query_params.rules shape for filtering by a connect-board column's linked item
  // id is written from current Monday API v2 knowledge but not verified against a live
  // account — verify against a real board before deploy (same caveat already flagged in
  // membership-reminders/src/monday.ts); a shape fix here covers both callers. donorItemId
  // isn't attacker-reachable today (it's derived from the session, never client-supplied),
  // but it's passed as a $donorItemId GraphQL variable rather than interpolated, as
  // defense-in-depth and for consistency with findDonorsByEmail above.
  private async fetchItemsLinkedToDonor(
    boardId: number,
    linkColumnId: string,
    donorItemId: string,
    columnIds: string[],
    includeName: boolean,
    // NOTE: reading a board_relation column's linked_item_ids via the `... on BoardRelationValue`
    // fragment is written from current Monday API v2 knowledge but not verified against a live
    // account — same verify-before-deploy caveat as the rules shape above.
    includeLinkedItemIds = false
  ): Promise<MondayItem[]> {
    const valueFields = includeLinkedItemIds ? '{ id text ... on BoardRelationValue { linked_item_ids } }' : '{ id text }';
    const itemFields = `id ${includeName ? 'name ' : ''}column_values(ids: ${JSON.stringify(columnIds)}) ${valueFields}`;
    const firstPageQuery = `
      query ($boardId: ID!, $donorItemId: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${linkColumnId}", compare_value: [$donorItemId], operator: any_of }]
            }
          ) {
            cursor
            items { ${itemFields} }
          }
        }
      }
    `;
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          items { ${itemFields} }
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId, donorItemId });
    const firstPage = firstData.boards[0]?.items_page;
    const allItems: MondayItem[] = [...(firstPage?.items ?? [])];
    let cursor = firstPage?.cursor ?? null;

    while (cursor) {
      const nextData = await this.request<{
        next_items_page: { cursor: string | null; items: MondayItem[] } | null;
      }>(nextPageQuery, { cursor });
      // A null next_items_page (expired/invalid cursor) ends pagination with what we have
      // rather than throwing mid-page and failing the whole read.
      const nextPage = nextData.next_items_page;
      if (!nextPage) break;
      allItems.push(...nextPage.items);
      cursor = nextPage.cursor;
    }

    return allItems;
  }

  private async getDonationsForDonor(donorItemId: string): Promise<DonationRecord[]> {
    const items = await this.fetchItemsLinkedToDonor(
      this.donationsBoardId,
      this.columns.donationDonorLink,
      donorItemId,
      [this.columns.donationAmount, this.columns.donationDate, this.columns.donationDescription],
      false
    );
    return items.map((item) => ({
      amount: columnText(item, this.columns.donationAmount),
      date: columnText(item, this.columns.donationDate),
      description: columnText(item, this.columns.donationDescription),
    }));
  }

  async getVolunteerShiftsForDonor(donorItemId: string): Promise<VolunteerShift[]> {
    // In-client defense mirroring the placeholder guards in findDonorsByEmail and
    // getDonorPortalData: routes.ts's volunteerHistoryEnabled gate is the intended entry
    // condition, but a future caller that misses it must fail loudly here rather than ship the
    // literal placeholder string (or a sentinel board id) to Monday's API.
    const volunteerColumns = [
      this.columns.volunteerDonorLink,
      this.columns.volunteerHours,
      this.columns.volunteerDate,
      this.columns.volunteerJob,
      this.columns.volunteerStatus,
    ];
    if (this.volunteersBoardId === null || volunteerColumns.some((id) => id === 'REPLACE_WITH_COLUMN_ID')) {
      throw new Error(
        'monday: volunteer history is not configured (monday.volunteersBoardId and every monday.columns.volunteer* id must be set) — gate calls with volunteerHistoryEnabled(config)'
      );
    }

    const items = await this.fetchItemsLinkedToDonor(
      this.volunteersBoardId,
      this.columns.volunteerDonorLink,
      donorItemId,
      [this.columns.volunteerHours, this.columns.volunteerDate, this.columns.volunteerJob, this.columns.volunteerStatus],
      false
    );
    return items.map((item) => ({
      hours: columnText(item, this.columns.volunteerHours),
      date: columnText(item, this.columns.volunteerDate),
      job: columnText(item, this.columns.volunteerJob),
      status: columnText(item, this.columns.volunteerStatus),
    }));
  }

  async getDonorNames(donorItemIds: string[]): Promise<{ id: string; name: string }[]> {
    if (donorItemIds.length === 0) return [];
    const query = `
      query ($itemIds: [ID!]) {
        items(ids: $itemIds) {
          id
          name
        }
      }
    `;
    const data = await this.request<{ items: MondayItem[] }>(query, { itemIds: donorItemIds });
    return (data.items ?? []).map((item) => ({ id: item.id, name: item.name }));
  }

  async getPledgesForDonor(donorItemId: string): Promise<PledgeRecord[]> {
    // Routes gate on pledgesEnabled before calling, so this only throws on a wiring bug —
    // loudly, rather than silently returning [] and rendering a misleading "no pledges" page.
    if (this.pledges === null) {
      throw new Error('monday: pledges board is not configured');
    }
    const { boardId, columns } = this.pledges;
    const items = await this.fetchItemsLinkedToDonor(
      boardId,
      columns.donorLink,
      donorItemId,
      [columns.pledgedAmount, columns.fulfilledAmount, columns.status, columns.dueDate],
      true
    );
    return items.map((item) => ({
      name: item.name,
      pledged: columnText(item, columns.pledgedAmount),
      fulfilled: columnText(item, columns.fulfilledAmount),
      status: columnText(item, columns.status),
      dueDate: columnText(item, columns.dueDate),
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
    const prefColumnIds = [this.columns.donorEmailOptOut, this.columns.donorSmsOptOut, this.columns.donorDoNotMail];
    for (const prefColumnId of prefColumnIds) {
      if (prefColumnId !== 'REPLACE_WITH_COLUMN_ID') {
        columnIds.push(prefColumnId);
      }
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
      emailOptOut: checkboxState(item, this.columns.donorEmailOptOut),
      smsOptOut: checkboxState(item, this.columns.donorSmsOptOut),
      doNotMail: checkboxState(item, this.columns.donorDoNotMail),
    };
  }

  async getEventRegistrationsForDonor(params: {
    donorItemId: string;
    boardId: number;
    columns: EventRegistrationColumns;
    eventDateColumnId: string;
  }): Promise<EventRegistrationRecord[]> {
    const { donorItemId, boardId, columns } = params;
    const registrations = await this.fetchItemsLinkedToDonor(
      boardId,
      columns.attendeeLink,
      donorItemId,
      [columns.attended, columns.eventLink],
      true,
      true
    );

    const linkedEventId = (item: MondayItem): string | null =>
      (item.column_values ?? []).find((c) => c.id === columns.eventLink)?.linked_item_ids?.[0] ?? null;

    const eventIds = [...new Set(registrations.map(linkedEventId).filter((id): id is string => id !== null))];
    const events = new Map<string, { name: string; date: string }>();
    if (eventIds.length > 0) {
      const eventsQuery = `
        query ($itemIds: [ID!]) {
          items(ids: $itemIds) {
            id
            name
            column_values(ids: ["${params.eventDateColumnId}"]) { id text }
          }
        }
      `;
      const eventsData = await this.request<{ items: MondayItem[] }>(eventsQuery, { itemIds: eventIds });
      for (const item of eventsData.items) {
        events.set(item.id, { name: item.name, date: columnText(item, params.eventDateColumnId) });
      }
    }

    return registrations.map((item) => {
      const event = events.get(linkedEventId(item) ?? '');
      return {
        registrationName: item.name,
        // NOTE: checkbox `text` is expected to be "v" when checked and ""/null when not — any
        // non-empty text counts as attended. Unverified against a live account, same caveat as
        // the query shapes above.
        eventName: event?.name ?? '',
        eventDate: event?.date ?? '',
        attended: columnText(item, columns.attended) !== '',
      };
    });
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

  async getLetterSettings(params: { boardId: number; columns: LetterCronColumns }): Promise<LetterSettings | null> {
    // The Letter Settings board holds a single staff-edited item, "Letter emails" (see
    // scripts/create-letter-settings-board.mjs). Prefer that item by name and only fall back to
    // the board's first item — Monday's board-creation template seeds default items ("Task 1")
    // that sort ahead of the real settings item, a failure observed live on the sandbox board.
    // Checkbox state comes from the CheckboxValue fragment's `checked` field rather than the
    // display text — Monday renders an unchecked box as null text and a checked one as "v",
    // neither of which is worth string-matching on.
    const localeColumnEntries = Object.entries(params.columns.bodyTemplatesByLocale) as [Locale, string][];
    const columnIds = [
      params.columns.autoSend,
      params.columns.startDate,
      params.columns.bodyTemplate,
      ...localeColumnEntries.map(([, columnId]) => columnId),
    ];
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(limit: 25) {
            items {
              id
              name
              column_values(ids: ${JSON.stringify(columnIds)}) {
                id
                text
                ... on CheckboxValue { checked }
              }
            }
          }
        }
      }
    `;
    const data = await this.request<{ boards: { items_page: { items: MondayItem[] } }[] }>(query, {
      boardId: params.boardId,
    });
    const items = data.boards[0]?.items_page.items ?? [];
    const named = items.find((i) => i.name === 'Letter emails');
    if (!named && items.length > 0) {
      console.warn(
        `monday: Letter Settings board ${params.boardId} has no item named "Letter emails" — falling back to its first item ("${items[0]!.name}")`
      );
    }
    const item = named ?? items[0];
    if (!item) return null;
    const autoSendValue = (item.column_values ?? []).find((c) => c.id === params.columns.autoSend);
    const bodyTemplatesByLocale: Partial<Record<Locale, string>> = {};
    for (const [locale, columnId] of localeColumnEntries) {
      const text = columnText(item, columnId);
      if (text.trim().length > 0) {
        bodyTemplatesByLocale[locale] = text;
      }
    }
    return {
      autoSend: autoSendValue?.checked === true,
      startDate: columnText(item, params.columns.startDate),
      bodyTemplate: columnText(item, params.columns.bodyTemplate),
      bodyTemplatesByLocale,
    };
  }

  async listDonorIdsWithDonationsInYear(year: number): Promise<string[]> {
    // Backs the January letter cron: one ids-only sweep of the Donations board bounded to the
    // target year, instead of a getDonorPortalData call per Donors-board item. The date-column
    // `between` rules shape (with the CheckboxValue/BoardRelationValue fragments this file
    // uses) was verified live on 2026-08-25 against the sandbox Donations board (18427756119) —
    // unlike the other rules-shape NOTEs in this file, this one is confirmed working. The
    // client-side year check below stays as a correctness backstop regardless.
    const columnIds = JSON.stringify([this.columns.donationDate, this.columns.donationDonorLink]);
    const itemFields = `items { id column_values(ids: ${columnIds}) { id text ... on BoardRelationValue { linked_item_ids } } }`;
    const firstPageQuery = `
      query ($boardId: ID!, $from: String!, $to: String!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [{ column_id: "${this.columns.donationDate}", compare_value: [$from, $to], operator: between }]
            }
          ) {
            cursor
            ${itemFields}
          }
        }
      }
    `;
    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          ${itemFields}
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId: this.donationsBoardId, from: `${year}-01-01`, to: `${year}-12-31` });
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

    const donorIds = new Set<string>();
    for (const item of allItems) {
      if (!columnText(item, this.columns.donationDate).startsWith(`${year}-`)) continue;
      const link = (item.column_values ?? []).find((c) => c.id === this.columns.donationDonorLink);
      for (const donorId of link?.linked_item_ids ?? []) {
        donorIds.add(donorId);
      }
    }
    return [...donorIds];
  }
}
