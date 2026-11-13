// Reads the Affiliations board and the configured opportunity boards, and writes each item's
// Contacts column. Columns are resolved by title once per board (through bareTitle, so a column
// titled "🔒 Contacts" is found by "Contacts"); a missing one throws ColumnLookupError.
//
// Only the confirmed `SVBC Roles` column is ever read for roles. `Proposed Roles` is never
// requested, so a proposed-only person cannot reach Contacts.
import { bareTitle } from '../../../scripts/lib/column-titles.mjs';
import { MONDAY_API_VERSION, MondayGraphQL, type MondayGraphQLOptions, type TokenProvider } from './graphql';
import type { BoardRule, ContactRolesConfig } from '../config';
import type { Affiliation, BoardItem } from '../contacts';

export interface ContactRolesMondayClient {
  roleLabels(cfg: ContactRolesConfig['affiliations']): Promise<string[]>;
  listAffiliations(cfg: ContactRolesConfig['affiliations']): Promise<Affiliation[]>;
  listBoardItems(rule: BoardRule): Promise<BoardItem[]>;
  setContacts(rule: BoardRule, itemId: string, personIds: string[]): Promise<void>;
}

export class ColumnLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColumnLookupError';
  }
}

interface BoardColumn { id: string; title: string; type: string; settings_str: string }

// `type`, when given, is asserted: a staff-made text or people column that happens to share the
// title (e.g. "Contacts") must never be read as, or overwritten like, the real one.
function columnByTitle(columns: BoardColumn[], title: string, boardId: string, type?: string): BoardColumn {
  const matches = columns.filter((c) => bareTitle(c.title) === bareTitle(title));
  if (matches.length === 0) throw new ColumnLookupError(`board ${boardId}: no column titled "${title}"`);
  if (matches.length > 1) throw new ColumnLookupError(`board ${boardId}: ${matches.length} columns titled "${title}"; rename one`);
  const col = matches[0]!;
  if (type !== undefined && col.type !== type) {
    throw new ColumnLookupError(`board ${boardId}: column "${title}" is type "${col.type}", expected "${type}"`);
  }
  return col;
}

interface RawColumnValue { id: string; text: string | null; linked_item_ids?: (string | number)[] | null; values?: { label: string }[] | null }
interface RawItem { id: string; column_values: RawColumnValue[] }
interface ItemsPage { cursor: string | null; items: RawItem[] }

// A reconcile has no queue behind it: the transport's own retries ride out a blip or the
// per-minute complexity budget, and a longer failure fails the run for the next one to redo.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 4, requestTimeoutMs: 30_000 };

const COLUMN_VALUES = 'column_values(ids: $columnIds) { id text ... on BoardRelationValue { linked_item_ids } ... on DropdownValue { values { label } } }';

const idsOf = (cv: RawColumnValue | undefined): string[] => (cv?.linked_item_ids ?? []).map(String);
const textOf = (cv: RawColumnValue | undefined): string | null => (cv?.text === undefined || cv.text === null || cv.text === '' ? null : cv.text);

export class HttpMondayClient implements ContactRolesMondayClient {
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
      // A failed lookup must not stay cached.
      cached.catch(() => this.columnCache.delete(boardId));
      this.columnCache.set(boardId, cached);
    }
    return cached;
  }

  private async pageAll(boardId: string, columnIds: string[], queryParams: unknown): Promise<RawItem[]> {
    const items: RawItem[] = [];
    const first = await this.transport.request<{ boards: { items_page: ItemsPage }[] }>(
      `query ($boardId: [ID!], $columnIds: [String!], $query: ItemsQuery) {
        boards(ids: $boardId) { items_page(limit: 500, query_params: $query) { cursor items { id ${COLUMN_VALUES} } } }
      }`,
      { boardId: [boardId], columnIds, query: queryParams },
    );
    let page = first.boards[0]?.items_page ?? { cursor: null, items: [] };
    items.push(...page.items);
    while (page.cursor !== null) {
      const next = await this.transport.request<{ next_items_page: ItemsPage }>(
        `query ($cursor: String!, $columnIds: [String!]) {
          next_items_page(limit: 500, cursor: $cursor) { cursor items { id ${COLUMN_VALUES} } }
        }`,
        { cursor: page.cursor, columnIds },
      );
      page = next.next_items_page;
      items.push(...page.items);
    }
    return items;
  }

  async roleLabels(cfg: ContactRolesConfig['affiliations']): Promise<string[]> {
    const col = columnByTitle(await this.columns(cfg.boardId), cfg.rolesColumn, cfg.boardId, 'dropdown');
    // Dropdown settings_str stores labels as {id, name} (item-level reads use `label`, a
    // different shape).
    const settings = JSON.parse(col.settings_str) as { labels?: { name?: unknown }[] };
    return (settings.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string');
  }

  async listAffiliations(cfg: ContactRolesConfig['affiliations']): Promise<Affiliation[]> {
    const cols = await this.columns(cfg.boardId);
    const roles = columnByTitle(cols, cfg.rolesColumn, cfg.boardId, 'dropdown').id;
    const status = columnByTitle(cols, cfg.statusColumn, cfg.boardId, 'status').id;
    const person = columnByTitle(cols, cfg.personColumn, cfg.boardId, 'board_relation').id;
    const org = columnByTitle(cols, cfg.orgColumn, cfg.boardId, 'board_relation').id;
    // Only SVBC Roles is requested; Proposed Roles is deliberately never read.
    const items = await this.pageAll(cfg.boardId, [person, org, status, roles], { rules: [{ column_id: roles, compare_value: [], operator: 'is_not_empty' }] });
    const out: Affiliation[] = [];
    for (const item of items) {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      const labels = (by.get(roles)?.values ?? []).map((v) => v.label);
      const personId = idsOf(by.get(person))[0];
      const orgId = idsOf(by.get(org))[0];
      if (labels.length === 0 || personId === undefined || orgId === undefined) continue;
      out.push({ id: item.id, personId, orgId, status: textOf(by.get(status)) ?? '', roles: labels });
    }
    return out;
  }

  async listBoardItems(rule: BoardRule): Promise<BoardItem[]> {
    const cols = await this.columns(rule.boardId);
    const org = columnByTitle(cols, rule.orgColumn, rule.boardId, 'board_relation').id;
    const contacts = columnByTitle(cols, rule.contactsColumn, rule.boardId, 'board_relation').id;
    const type = rule.typeColumn === undefined ? null : columnByTitle(cols, rule.typeColumn, rule.boardId).id;
    // A sparse board (Donations) reads items with an org link, plus items that still carry
    // Contacts after the link was cleared, so those stale contacts can be removed.
    const queryParams = rule.sparse === true
      ? { operator: 'or', rules: [org, contacts].map((id) => ({ column_id: id, compare_value: [], operator: 'is_not_empty' })) }
      : null;
    const items = await this.pageAll(rule.boardId, type === null ? [org, contacts] : [org, contacts, type], queryParams);
    return items.map((item) => {
      const by = new Map(item.column_values.map((cv) => [cv.id, cv]));
      return {
        id: item.id,
        orgIds: idsOf(by.get(org)),
        typeLabel: type === null ? null : textOf(by.get(type)),
        currentPersonIds: idsOf(by.get(contacts)),
      };
    });
  }

  async setContacts(rule: BoardRule, itemId: string, personIds: string[]): Promise<void> {
    const bad = personIds.filter((id) => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)));
    if (bad.length > 0) throw new Error(`setContacts: item ${itemId} on board ${rule.boardId}: ${bad.length} person id(s) are not numeric`);
    const contacts = columnByTitle(await this.columns(rule.boardId), rule.contactsColumn, rule.boardId, 'board_relation').id;
    // Connect-boards value; an empty list clears the column. Writing the same set twice is
    // harmless, so the transport may retry it.
    const values = { [contacts]: { item_ids: personIds.map(Number) } };
    await this.transport.request<{ change_multiple_column_values: { id: string } }>(
      `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
      }`,
      { boardId: rule.boardId, itemId, values: JSON.stringify(values) },
    );
  }
}
