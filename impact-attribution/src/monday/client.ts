// Reads active Matching Donations, the Affiliations board and (for email-domain proposals) People
// and Organizations, checks items still exist, and writes Draft Affiliations with an evidence
// comment. Columns are resolved by title once per board
// (through bareTitle, so "🔒 Proposed status" is found by "Proposed status"); a missing one, or one
// of the wrong type, throws ColumnLookupError.
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';
import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';
import type { ImpactAttributionConfig } from '../config';
import type { OrganizationCandidate } from '../employerName';
import { pairKey, type MatchRow } from '../rule';
import type { BoardMatchRead } from '../store';
import type { AffiliationRecord, OrganizationRecord } from '../emailDomains/domains';
import type { PersonRecord } from '../emailDomains/select';

export interface ImpactMondayClient {
  readActiveMatches(cfg: ImpactAttributionConfig): Promise<BoardMatchRead>;
  existingAffiliationPairs(cfg: ImpactAttributionConfig['affiliations']): Promise<Set<string>>;
  activeItems(ids: string[]): Promise<Map<string, string>>;
  createDraft(cfg: ImpactAttributionConfig['affiliations'], d: { name: string; personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former' }): Promise<string>;
  postUpdate(itemId: string, body: string): Promise<void>;
  // Exact-name lookup on the Organizations board; the caller compares normalised names.
  findOrganizationsByNames(boardId: string, names: string[]): Promise<OrganizationCandidate[]>;
  // Email-domain proposals (#124): whole-board reads of People, Organizations and Affiliations.
  listPeople(boardId: string, cols: ImpactAttributionConfig['emailDomains']['people']): Promise<PersonRecord[]>;
  listOrganizations(boardId: string, websiteTitle: string): Promise<OrganizationRecord[]>;
  listAffiliations(cfg: ImpactAttributionConfig['affiliations'], workEmailTitle: string): Promise<AffiliationRecord[]>;
}

export class ColumnLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColumnLookupError';
  }
}

export interface RawMatchItem {
  id: string;
  giftType: string | null;
  matchedBy: { id: string; boardId: string }[];
  donor: { id: string; boardId: string }[];
  date: string | null;
  amount: string | null;
}

// Spec "The rule": a storable match is a Matching Donation with exactly one Matched By on
// Organizations, exactly one Donor on a People board, and a Date. Anything else returns null.
export function parseMatchItem(item: RawMatchItem, cfg: ImpactAttributionConfig): MatchRow | null {
  if (item.giftType !== cfg.donations.matchingGiftLabel) return null;
  if (item.matchedBy.length !== 1 || item.matchedBy[0]!.boardId !== cfg.organizationsBoardId) return null;
  if (item.donor.length !== 1 || !cfg.peopleBoardIds.includes(item.donor[0]!.boardId)) return null;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(item.date ?? '')?.[0];
  if (date === undefined) return null;
  const amount = item.amount === null || item.amount.trim() === '' ? NaN : Number(item.amount);
  return {
    donationItemId: item.id, personItemId: item.donor[0]!.id, orgItemId: item.matchedBy[0]!.id, matchDate: date,
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
  };
}

interface BoardColumn { id: string; title: string; type: string }

function columnByTitle(columns: BoardColumn[], title: string, boardId: string, type?: string): BoardColumn {
  const matches = columns.filter((c) => bareTitle(c.title) === bareTitle(title));
  if (matches.length === 0) throw new ColumnLookupError(`board ${boardId}: no column titled "${title}"`);
  if (matches.length > 1) throw new ColumnLookupError(`board ${boardId}: ${matches.length} columns titled "${title}"; rename one`);
  const col = matches[0]!;
  if (type !== undefined && col.type !== type) throw new ColumnLookupError(`board ${boardId}: column "${title}" is type "${col.type}", expected "${type}"`);
  return col;
}

interface RawColumnValue {
  id: string; text: string | null; linked_items?: { id: string | number; board: { id: string | number } | null }[] | null;
  email?: string | null; url?: string | null; date?: string | null; label?: string | null;
}
interface RawItem { id: string; name: string; column_values: RawColumnValue[] }
interface ItemsPage { cursor: string | null; items: RawItem[] }
interface NamePage { cursor: string | null; items: { id: string; name: string }[] }

// A nightly run has no queue behind it: the transport's own retries ride out a blip, and a longer
// failure fails the run for the next night to redo.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 30_000 };

// Typed fragments where `text` misleads: an email's or link's text can carry a label ("Jo -
// jo@acme.example"), and a date's text follows the account's display format.
const COLUMN_VALUES = `column_values(ids: $columnIds) { id text
  ... on BoardRelationValue { linked_items { id board { id } } }
  ... on EmailValue { email } ... on LinkValue { url } ... on DateValue { date } ... on StatusValue { label } }`;
const ID_CHUNK = 100;
const NAME_CHUNK = 100;

const linksOf = (cv: RawColumnValue | undefined): { id: string; boardId: string }[] =>
  (cv?.linked_items ?? []).map((l) => ({ id: String(l.id), boardId: String(l.board?.id ?? '') }));
const textOf = (cv: RawColumnValue | undefined): string | null => (cv?.text === undefined || cv.text === null || cv.text === '' ? null : cv.text);
const blank = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === '' ? null : s);
const emailOf = (cv: RawColumnValue | undefined): string | null => blank(cv?.email)?.trim().toLowerCase() ?? null;

const numericIds = (ids: string[], what: string): number[] => {
  if (!ids.every((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)))) throw new Error(`${what}: item id is not numeric`);
  return ids.map(Number);
};

export class HttpMondayClient implements ImpactMondayClient {
  private readonly transport: MondayGraphQL;
  private readonly columnCache = new Map<string, Promise<BoardColumn[]>>();

  constructor(apiUrl: string, token: string | TokenProvider, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, token, { ...DEFAULT_OPTIONS, ...options, apiVersion: MONDAY_API_VERSION });
  }

  private columns(boardId: string): Promise<BoardColumn[]> {
    let cached = this.columnCache.get(boardId);
    if (cached === undefined) {
      cached = this.transport
        .request<{ boards: { columns: BoardColumn[] }[] }>(
          `query ($boardId: [ID!]) { boards(ids: $boardId) { id columns { id title type settings_str } } }`,
          { boardId: [boardId] },
        )
        .then((data) => {
          const board = data.boards[0];
          if (board === undefined) throw new ColumnLookupError(`board ${boardId}: not found or not visible`);
          return board.columns;
        });
      cached.catch(() => this.columnCache.delete(boardId));
      this.columnCache.set(boardId, cached);
    }
    return cached;
  }

  private async pageAll(boardId: string, columnIds: string[], queryParams: unknown): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const first = await this.transport.request<{ boards: { items_page: ItemsPage }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $query: ItemsQuery) {
        boards(ids: $boardId) { items_page(limit: 500, query_params: $query) { cursor items { id name ${COLUMN_VALUES} } } }
      }`,
      { boardId: [boardId], columnIds, query: queryParams },
    );
    let page = first.boards[0]?.items_page ?? { cursor: null, items: [] };
    items.push(...page.items);
    while (page.cursor !== null) {
      const next = await this.transport.request<{ next_items_page: ItemsPage }>(
        `query ($cursor: String!, $columnIds: [String!]) {
          next_items_page(limit: 500, cursor: $cursor) { cursor items { id name ${COLUMN_VALUES} } }
        }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
      items.push(...page.items);
    }
    return items;
  }

  async readActiveMatches(cfg: ImpactAttributionConfig): Promise<BoardMatchRead> {
    const d = cfg.donations;
    const cols = await this.columns(d.boardId);
    const giftType = columnByTitle(cols, d.giftType, d.boardId, 'text').id;
    const matchedBy = columnByTitle(cols, d.matchedBy, d.boardId, 'board_relation').id;
    const donor = columnByTitle(cols, d.donor, d.boardId, 'board_relation').id;
    const date = columnByTitle(cols, d.date, d.boardId, 'date').id;
    const amount = columnByTitle(cols, d.amount, d.boardId, 'numbers').id;
    // Donations is far too large to read in full; only items with a Matched By can be matches.
    const items = await this.pageAll(d.boardId, [giftType, matchedBy, donor, date, amount], {
      rules: [{ column_id: matchedBy, compare_value: [], operator: 'is_not_empty' }],
    });
    const read: BoardMatchRead = { stored: [], rejectedIds: [] };
    for (const item of items) {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      const row = parseMatchItem({
        id: item.id, giftType: textOf(by.get(giftType)), matchedBy: linksOf(by.get(matchedBy)), donor: linksOf(by.get(donor)),
        date: textOf(by.get(date)), amount: textOf(by.get(amount)),
      }, cfg);
      if (row === null) read.rejectedIds.push(item.id);
      else read.stored.push(row);
    }
    return read;
  }

  async existingAffiliationPairs(cfg: ImpactAttributionConfig['affiliations']): Promise<Set<string>> {
    const cols = await this.columns(cfg.boardId);
    const person = columnByTitle(cols, cfg.person, cfg.boardId, 'board_relation').id;
    const org = columnByTitle(cols, cfg.organization, cfg.boardId, 'board_relation').id;
    const pairs = new Set<string>();
    for (const item of await this.pageAll(cfg.boardId, [person, org], null)) {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      for (const p of linksOf(by.get(person))) for (const o of linksOf(by.get(org))) pairs.add(pairKey(p.id, o.id));
    }
    return pairs;
  }

  async activeItems(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const chunk = unique.slice(i, i + ID_CHUNK);
      const data = await this.transport.request<{ items: { id: string; name: string; state: string | null }[] }>(
        `query ($ids: [ID!]) { items(ids: $ids, limit: ${ID_CHUNK}) { id name state } }`,
        { ids: chunk },
      );
      for (const item of data.items) if (item.state === 'active') out.set(String(item.id), item.name);
    }
    return out;
  }

  async createDraft(
    cfg: ImpactAttributionConfig['affiliations'],
    d: { name: string; personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former' },
  ): Promise<string> {
    const cols = await this.columns(cfg.boardId);
    const values = {
      [columnByTitle(cols, cfg.person, cfg.boardId, 'board_relation').id]: { item_ids: numericIds([d.personItemId], 'createDraft') },
      [columnByTitle(cols, cfg.organization, cfg.boardId, 'board_relation').id]: { item_ids: numericIds([d.orgItemId], 'createDraft') },
      [columnByTitle(cols, cfg.status, cfg.boardId, 'status').id]: { label: cfg.labels.draft },
      [columnByTitle(cols, cfg.proposedStatus, cfg.boardId, 'status').id]: {
        label: d.proposedStatus === 'Current' ? cfg.labels.current : cfg.labels.former,
      },
    };
    // A create is not idempotent: a retried create after a lost response would make a duplicate.
    const data = await this.transport.request<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $itemName: String!, $values: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $values) { id }
      }`,
      { boardId: cfg.boardId, itemName: d.name, values: JSON.stringify(values) },
      { idempotent: false },
    );
    return String(data.create_item.id);
  }

  async postUpdate(itemId: string, body: string): Promise<void> {
    await this.transport.request<{ create_update: { id: string } }>(
      `mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId, body },
      { idempotent: false },
    );
  }

  // As member-portal's method of the same purpose: one items_page_by_column_values per 100 names,
  // `any_of` on the name column (Monday's match is exact, hence the caller's name variants), each
  // followed through next_items_page until the cursor runs out: a dropped page could hide a second
  // same-name Organization and turn "several" into "one". An Organization found under two names
  // is returned once.
  async findOrganizationsByNames(boardId: string, names: string[]): Promise<OrganizationCandidate[]> {
    const unique = [...new Set(names)];
    const found = new Map<string, OrganizationCandidate>();
    const add = (items: { id: string; name: string }[]): void => {
      for (const item of items) found.set(String(item.id), { id: String(item.id), name: item.name });
    };
    for (let i = 0; i < unique.length; i += NAME_CHUNK) {
      const data = await this.transport.request<{ items_page_by_column_values: NamePage }>(
        `query ($boardId: ID!, $columns: [ItemsPageByColumnValuesQuery!]!) {
          items_page_by_column_values(board_id: $boardId, limit: 500, columns: $columns) { cursor items { id name } }
        }`,
        { boardId, columns: [{ column_id: 'name', column_values: unique.slice(i, i + NAME_CHUNK) }] },
      );
      let page = data.items_page_by_column_values;
      add(page.items);
      while (page.cursor !== null && page.cursor !== undefined) {
        const next = await this.transport.request<{ next_items_page: NamePage }>(
          `query ($cursor: String!) { next_items_page(limit: 500, cursor: $cursor) { cursor items { id name } } }`,
          { cursor: page.cursor },
        );
        page = next.next_items_page;
        add(page.items);
      }
    }
    return [...found.values()];
  }

  async listPeople(boardId: string, cols: ImpactAttributionConfig['emailDomains']['people']): Promise<PersonRecord[]> {
    const c = await this.columns(boardId);
    const personal = columnByTitle(c, cols.personalEmail, boardId, 'email').id;
    const household = columnByTitle(c, cols.householdEmail, boardId, 'email').id;
    const employer = columnByTitle(c, cols.employerName, boardId).id;
    const lastGift = columnByTitle(c, cols.lastGiftDate, boardId, 'date').id;
    return (await this.pageAll(boardId, [personal, household, employer, lastGift], null)).map((item) => {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      return {
        itemId: String(item.id), boardId, name: item.name,
        personalEmail: emailOf(by.get(personal)), householdEmail: emailOf(by.get(household)),
        employerName: blank(by.get(employer)?.text), lastGiftDate: blank(by.get(lastGift)?.date),
      };
    });
  }

  async listOrganizations(boardId: string, websiteTitle: string): Promise<OrganizationRecord[]> {
    const website = columnByTitle(await this.columns(boardId), websiteTitle, boardId, 'link').id;
    return (await this.pageAll(boardId, [website], null)).map((item) => ({
      itemId: String(item.id), name: item.name, websiteUrl: blank(item.column_values.find((cv) => cv.id === website)?.url),
    }));
  }

  async listAffiliations(cfg: ImpactAttributionConfig['affiliations'], workEmailTitle: string): Promise<AffiliationRecord[]> {
    const c = await this.columns(cfg.boardId);
    const person = columnByTitle(c, cfg.person, cfg.boardId, 'board_relation').id;
    const org = columnByTitle(c, cfg.organization, cfg.boardId, 'board_relation').id;
    const status = columnByTitle(c, cfg.status, cfg.boardId, 'status').id;
    const workEmail = columnByTitle(c, workEmailTitle, cfg.boardId, 'email').id;
    return (await this.pageAll(cfg.boardId, [person, org, status, workEmail], null)).map((item) => {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      return {
        itemId: String(item.id), personIds: linksOf(by.get(person)).map((l) => l.id), organizationIds: linksOf(by.get(org)).map((l) => l.id),
        status: blank(by.get(status)?.label), workEmail: emailOf(by.get(workEmail)),
      };
    });
  }
}
