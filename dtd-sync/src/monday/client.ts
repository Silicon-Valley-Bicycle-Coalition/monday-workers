import type { DtdSyncConfig } from '../config';
import { MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';

export interface DonationItem {
  id: string; amount: number | null; date: string | null; status: string | null; giftType: string | null;
  funraiseId: string | null; salesforceId: string | null; benevityTransactionId: string | null;
  anonymous: boolean; donorItemId: string | null; matchedByItemId: string | null;
  matchesGiftItemId: string | null; matchPairing: string | null; matchStatus: string | null;
  sentToDtd: string | null; updatedAt: string;
}
export interface PersonItem { id: string; email: string | null; householdEmail: string | null; firstName: string; lastName: string; phone: string | null; dtdCompanyId: string | null }

export interface DtdMondayClient {
  findDonationByFunraiseId(id: string): Promise<DonationItem | null>;
  findDonationBySalesforceId(id: string): Promise<DonationItem | null>;
  getDonation(itemId: string): Promise<DonationItem | null>;
  listDonationsDatedSince(dateISO: string): Promise<DonationItem[]>;
  listGiftsForDonor(donorItemId: string, fromISO: string): Promise<DonationItem[]>;
  getPeople(ids: string[]): Promise<PersonItem[]>;
  getOrganizationName(itemId: string): Promise<string | null>;
  updateDonation(itemId: string, values: Record<string, unknown>): Promise<void>;
  updatePerson(itemId: string, values: Record<string, unknown>): Promise<void>;
  upsertProgramSummary(fiscalYear: string, values: Record<string, unknown>): Promise<void>;
}

// Same tuning as the other queue/cron Workers: a few quick in-process retries.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 30_000 };

interface ColumnValue { id: string; text: string | null; value?: string | null; linked_item_ids?: string[] }
interface RawItem { id: string; name?: string; state?: string | null; updated_at?: string | null; board?: { id: string } | null; column_values: ColumnValue[] }
interface ItemsPage { cursor: string | null; items: RawItem[] }

// A status cell's label, or null when empty. Monday returns label id 5's text for an EMPTY status
// cell, so the stored value (null, or JSON without a numeric `index`) decides, never the text.
function statusLabel(cv: ColumnValue | undefined): string | null {
  if (!cv || cv.value === null || cv.value === undefined || cv.value.trim() === '') return null;
  try {
    const parsed = JSON.parse(cv.value) as { index?: unknown } | null;
    if (typeof parsed?.index !== 'number') return null;
  } catch {
    return null;
  }
  const text = cv.text?.trim();
  return text ? text : null;
}

function text(cv: ColumnValue | undefined): string | null {
  const t = cv?.text?.trim();
  return t ? t : null;
}

function checked(cv: ColumnValue | undefined): boolean {
  if (!cv?.value) return false;
  try {
    const v = (JSON.parse(cv.value) as { checked?: unknown } | null)?.checked;
    return v === true || v === 'true';
  } catch {
    return false;
  }
}

function amount(cv: ColumnValue | undefined): number | null {
  const t = text(cv);
  if (t === null) return null;
  const n = Number(t.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && /\d/.test(t) ? n : null;
}

// Trashed items keep coming back with state 'deleted'; archived ones are kept (older fiscal years
// live archived on the same board and pairing may need them).
function live(item: { state?: string | null }): boolean {
  return item.state !== 'deleted';
}

// `items(ids:)` reads any item the token can see, whatever its board; an id from a connect column
// or a `monday-<id>` identifier can point elsewhere (Organizations, People (Historical)).
function onBoard(item: RawItem, boardId: number): boolean {
  return item.board?.id !== undefined && String(item.board.id) === String(boardId);
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// People have no first/last name columns; the item name is split on whitespace, the last token
// being the last name and the rest the first. A single word is a first name.
export function splitName(name: string): { firstName: string; lastName: string } {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0]!, lastName: '' };
  return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1]! };
}

export class HttpDtdMondayClient implements DtdMondayClient {
  private readonly transport: MondayGraphQL;

  constructor(apiUrl: string, apiToken: string | TokenProvider, private readonly config: DtdSyncConfig, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options });
  }

  private get donationColumnIds(): string[] {
    const { donations: d } = this.config;
    return [d.amount, d.date, d.status, d.giftType, d.funraiseId, d.salesforceId, d.benevityTransactionId,
      d.anonymousDonor, d.donor, d.matchedBy, d.matchStatus, d.matchesGift, d.matchPairing, d.sentToDtd];
  }

  // Interpolated into queries only as config-supplied column ids / JSON-encoded id lists — never
  // a caller's value; those are always GraphQL variables.
  private get donationFields(): string {
    return `id state updated_at board { id } column_values(ids: ${JSON.stringify(this.donationColumnIds)}) { id text value ... on BoardRelationValue { linked_item_ids } }`;
  }

  private donationFrom(item: RawItem): DonationItem {
    const d = this.config.donations;
    const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
    const link = (id: string): string | null => byId.get(id)?.linked_item_ids?.[0] ?? null;
    return {
      id: item.id,
      amount: amount(byId.get(d.amount)),
      date: text(byId.get(d.date)),
      status: statusLabel(byId.get(d.status)),
      giftType: text(byId.get(d.giftType)),
      funraiseId: text(byId.get(d.funraiseId)),
      salesforceId: text(byId.get(d.salesforceId)),
      benevityTransactionId: text(byId.get(d.benevityTransactionId)),
      anonymous: checked(byId.get(d.anonymousDonor)),
      donorItemId: link(d.donor),
      matchedByItemId: link(d.matchedBy),
      matchesGiftItemId: link(d.matchesGift),
      matchPairing: statusLabel(byId.get(d.matchPairing)),
      matchStatus: statusLabel(byId.get(d.matchStatus)),
      sentToDtd: text(byId.get(d.sentToDtd)),
      updatedAt: item.updated_at ?? '',
    };
  }

  private async findDonationByColumn(columnId: string, value: string): Promise<DonationItem | null> {
    const data = await this.transport.request<{ items_page_by_column_values: { items: RawItem[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, limit: 100, columns: $columns) { items { ${this.donationFields} } }
      }`,
      { boardId: this.config.boards.donations, columns: [{ column_id: columnId, column_values: [value] }] },
    );
    const item = data.items_page_by_column_values.items.find(live);
    return item ? this.donationFrom(item) : null;
  }

  // Funraise ID is a link column (URL + the bare id as link text); funraise-sync's adopt-before-create
  // lookup passes the bare id (funraise-sync/src/consumer/processBatch.ts:210), which matches the text.
  findDonationByFunraiseId(id: string): Promise<DonationItem | null> {
    return this.findDonationByColumn(this.config.donations.funraiseId, id);
  }

  findDonationBySalesforceId(id: string): Promise<DonationItem | null> {
    return this.findDonationByColumn(this.config.donations.salesforceId, id);
  }

  async getDonation(itemId: string): Promise<DonationItem | null> {
    const data = await this.transport.request<{ items: RawItem[] }>(
      `query ($ids: [ID!]) { items(ids: $ids) { ${this.donationFields} } }`,
      { ids: [itemId] },
    );
    const item = data.items[0];
    return item && live(item) && onBoard(item, this.config.boards.donations) ? this.donationFrom(item) : null;
  }

  // Runs a board query with `rules`, then follows next_items_page cursors to the end.
  private async pageDonations(
    variableDecls: string, rules: string, variables: Record<string, unknown>,
  ): Promise<DonationItem[]> {
    const first = await this.transport.request<{ boards: { items_page: ItemsPage }[] }>(
      `query ($boardId: [ID!], ${variableDecls}) {
        boards(ids: $boardId) {
          items_page(limit: 500, query_params: { rules: [${rules}] }) { cursor items { ${this.donationFields} } }
        }
      }`,
      { boardId: [this.config.boards.donations], ...variables },
    );
    let page = first.boards[0]?.items_page;
    const out: DonationItem[] = [];
    while (page) {
      out.push(...page.items.filter(live).map((i) => this.donationFrom(i)));
      if (page.cursor === null) break;
      const next: { next_items_page: ItemsPage } = await this.transport.request(
        `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { ${this.donationFields} } } }`,
        { cursor: page.cursor },
      );
      page = next.next_items_page;
    }
    return out;
  }

  async listDonationsDatedSince(dateISO: string): Promise<DonationItem[]> {
    const col = this.config.donations.date;
    const items = await this.pageDonations(
      '$since: CompareValue!',
      `{ column_id: "${col}", compare_value: $since, operator: greater_than_or_equals }`,
      { since: ['EXACT', dateISO] },
    );
    // Don't trust the server-side date filter alone; an undated gift can't be placed in the window.
    return items.filter((d) => d.date !== null && d.date >= dateISO);
  }

  async listGiftsForDonor(donorItemId: string, fromISO: string): Promise<DonationItem[]> {
    const col = this.config.donations.donor;
    // board_relation filters take the numeric item id (member-portal verified this shape).
    const items = await this.pageDonations(
      '$donorItemId: CompareValue',
      `{ column_id: "${col}", compare_value: [$donorItemId], operator: any_of }`,
      { donorItemId: Number(donorItemId) },
    );
    return items.filter((d) => d.date !== null && d.date >= fromISO);
  }

  async getPeople(ids: string[]): Promise<PersonItem[]> {
    const p = this.config.people;
    const peopleBoard = this.config.boards.people;
    const out: PersonItem[] = [];
    for (const chunk of chunksOf(ids, 100)) {
      const data = await this.transport.request<{ items: RawItem[] }>(
        `query ($ids: [ID!], $columnIds: [String!]) {
          items(ids: $ids, limit: 100) { id name state board { id } column_values(ids: $columnIds) { id text value } }
        }`,
        { ids: chunk, columnIds: [p.email, p.householdEmail, p.phone, p.dtdCompanyId] },
      );
      // Only People-board donors: an Organizations or People (Historical) donor has no DTD columns.
      for (const item of data.items.filter((i) => live(i) && onBoard(i, peopleBoard))) {
        const byId = new Map(item.column_values.map((cv) => [cv.id, cv]));
        out.push({
          id: item.id,
          email: text(byId.get(p.email)) ?? text(byId.get(p.householdEmail)),
          householdEmail: text(byId.get(p.householdEmail)),
          ...splitName(item.name ?? ''),
          phone: text(byId.get(p.phone)),
          dtdCompanyId: text(byId.get(p.dtdCompanyId)),
        });
      }
    }
    return out;
  }

  async getOrganizationName(itemId: string): Promise<string | null> {
    const data = await this.transport.request<{ items: { id: string; name: string }[] }>(
      `query ($ids: [ID!]) { items(ids: $ids) { id name } }`,
      { ids: [itemId] },
    );
    const name = data.items[0]?.name?.trim();
    return name ? name : null;
  }

  private async changeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>): Promise<void> {
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues, create_labels_if_missing: false) { id }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(values) },
    );
  }

  updateDonation(itemId: string, values: Record<string, unknown>): Promise<void> {
    return this.changeColumnValues(this.config.boards.donations, itemId, values);
  }

  updatePerson(itemId: string, values: Record<string, unknown>): Promise<void> {
    return this.changeColumnValues(this.config.boards.people, itemId, values);
  }

  async upsertProgramSummary(fiscalYear: string, values: Record<string, unknown>): Promise<void> {
    const boardId = this.config.boards.programSummary;
    const fyColumn = this.config.programSummary.fiscalYear;
    const found = await this.transport.request<{ items_page_by_column_values: { items: { id: string; state?: string | null }[] } }>(
      `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
        items_page_by_column_values(board_id: $boardId, limit: 100, columns: $columns) { items { id state } }
      }`,
      { boardId, columns: [{ column_id: fyColumn, column_values: [fiscalYear] }] },
    );
    const existing = found.items_page_by_column_values.items.find(live);
    if (existing) {
      await this.changeColumnValues(boardId, existing.id, values);
      return;
    }
    // Not idempotent: a create that may have committed throws AmbiguousWriteError and the next
    // run's lookup above adopts the item rather than duplicating it.
    await this.transport.request(
      `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: false) { id }
      }`,
      { boardId, itemName: fiscalYear, columnValues: JSON.stringify({ ...values, [fyColumn]: fiscalYear }) },
      { idempotent: false },
    );
  }
}
