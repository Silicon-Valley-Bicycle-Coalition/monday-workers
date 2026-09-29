import type { MondayColumnsConfig, DonorRecord } from '../types';
import { MondayGraphQL, type MondayGraphQLOptions } from './graphql';

// The consumer's backoff reads Monday's code and retry hint off this (consumer/backoff.ts).
export { AmbiguousWriteError, MondayApiError } from './graphql';

export interface MondayClient {
  getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null>;
  createCampaignItem(boardId: number, name: string): Promise<string>;
  renameItem(boardId: number, itemId: string, name: string): Promise<void>;
  archiveItem(itemId: string): Promise<void>;
  findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null>;
  setConnectColumn(boardId: number, itemId: string, columnId: string, linkedItemIds: string[]): Promise<void>;
}

// The queries below were written and verified against 2026-01; the canonical transport's
// default is newer, so pin this Worker's version explicitly until they're re-checked.
const MONDAY_API_VERSION = '2026-01';

// Queue-consumer tuning (#35): a few quick in-process retries ride out a Monday blip or the
// per-minute complexity budget. Anything longer surfaces as a MondayApiError carrying Monday's
// code and retry hint, and the consumer picks the queue delay from it (consumer/backoff.ts) —
// including a daily-limit error, which the transport never retries in-process.
const DEFAULT_OPTIONS: MondayGraphQLOptions = { maxAttempts: 3, requestTimeoutMs: 20_000, apiVersion: MONDAY_API_VERSION };

export class HttpMondayClient implements MondayClient {
  private readonly transport: MondayGraphQL;

  constructor(apiUrl: string, apiToken: string, options: MondayGraphQLOptions = {}) {
    this.transport = new MondayGraphQL(apiUrl, apiToken, { ...DEFAULT_OPTIONS, ...options });
  }

  async getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null> {
    const columnIds = [
      columns.email, columns.membershipStatus, columns.membershipTier,
      columns.memberSince, columns.memberUntil, columns.addr1, columns.city,
      columns.state, columns.zip, columns.totalGiven, columns.doNotSolicit, columns.dnsReasonStatus,
    ];
    const data = await this.transport.request<{ items: { id: string; column_values: { id: string; text: string | null }[] }[] }>(
      `query ($itemId: ID!, $columnIds: [String!]) {
        items(ids: [$itemId]) { id column_values(ids: $columnIds) { id text } }
      }`,
      { itemId, columnIds },
    );
    const item = data.items[0];
    if (item === undefined) return null;

    const byId = new Map(item.column_values.map((cv) => [cv.id, cv.text ?? '']));
    return {
      id: item.id,
      email: byId.get(columns.email) ?? '',
      membershipStatus: byId.get(columns.membershipStatus) ?? '',
      membershipTier: byId.get(columns.membershipTier) ?? '',
      memberSince: byId.get(columns.memberSince) ?? '',
      memberUntil: byId.get(columns.memberUntil) ?? '',
      addr1: byId.get(columns.addr1) ?? '',
      city: byId.get(columns.city) ?? '',
      state: byId.get(columns.state) ?? '',
      zip: byId.get(columns.zip) ?? '',
      totalGiven: byId.get(columns.totalGiven) ?? '',
      // A checkbox column's text is "v" when checked and "" when not.
      doNotSolicit: (byId.get(columns.doNotSolicit) ?? '') !== '',
      dnsReasonStatus: byId.get(columns.dnsReasonStatus) ?? '',
    };
  }

  async createCampaignItem(boardId: number, name: string): Promise<string> {
    const data = await this.transport.request<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $name: String!) {
        create_item(board_id: $boardId, item_name: $name) { id }
      }`,
      { boardId, name },
      // Not idempotent: a create that may have committed throws AmbiguousWriteError rather than
      // being retried into a duplicate campaign item.
      { idempotent: false },
    );
    return data.create_item.id;
  }

  // Monday's item name isn't editable via a normal column mutation, but the item
  // schema treats "name" itself as a simple-value column with id "name" — a
  // documented, commonly-used trick, not a real user-defined column. Verify against
  // Monday's current API docs if this ever starts failing.
  async renameItem(boardId: number, itemId: string, name: string): Promise<void> {
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $name: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "name", value: $name) { id }
      }`,
      { boardId, itemId, name },
    );
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.transport.request(
      `mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
      { itemId },
    );
  }

  // Text-column filtering is supported by Monday's API — donation-rollups hit a wall
  // specifically with board_relation columns, not plain text ones, so this is safe.
  async findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null> {
    const data = await this.transport.request<{ items_page_by_column_values: { items: { id: string }[] } }>(
      `query ($boardId: ID!, $columnId: String!, $email: [String]!) {
        items_page_by_column_values(board_id: $boardId, columns: [{ column_id: $columnId, column_values: $email }], limit: 1) {
          items { id }
        }
      }`,
      { boardId, columnId: emailColumnId, email: [email] },
    );
    const exactMatch = data.items_page_by_column_values.items[0]?.id;
    if (exactMatch !== undefined) return exactMatch;
    return this.findItemIdByEmailInsensitive(boardId, emailColumnId, email);
  }

  // items_page_by_column_values matches exact strings only, and salesforce-import
  // lowercases every email it writes — but a staff-entered Donor item can hold the
  // email mixed-case, which would otherwise be a permanent silent miss. Rare path,
  // so the extra API call is fine: contains_text narrows the candidates server-side,
  // then we compare lowercased to keep the match strict.
  private async findItemIdByEmailInsensitive(boardId: number, emailColumnId: string, email: string): Promise<string | null> {
    const data = await this.transport.request<{
      boards?: { items_page: { items: { id: string; column_values: { text: string | null }[] }[] } }[];
    }>(
      `query ($boardId: ID!, $columnId: ID!, $columnIds: [String!], $email: CompareValue!) {
        boards(ids: [$boardId]) {
          items_page(limit: 25, query_params: { rules: [{ column_id: $columnId, compare_value: $email, operator: contains_text }] }) {
            items { id column_values(ids: $columnIds) { text } }
          }
        }
      }`,
      { boardId, columnId: emailColumnId, columnIds: [emailColumnId], email: [email] },
    );
    const wanted = email.trim().toLowerCase();
    const items = data.boards?.[0]?.items_page.items ?? [];
    return items.find((item) =>
      item.column_values.some((cv) => (cv.text ?? '').trim().toLowerCase() === wanted),
    )?.id ?? null;
  }

  // Writes the *full current set* of linked items, not a diff — same
  // recompute-the-whole-thing philosophy as donation-rollups' rollup writes. Simpler
  // and self-healing; cheap at the scale of one donor's campaign memberships.
  async setConnectColumn(boardId: number, itemId: string, columnId: string, linkedItemIds: string[]): Promise<void> {
    await this.transport.request(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      { boardId, itemId, columnId, value: JSON.stringify({ item_ids: linkedItemIds.map(Number) }) },
    );
  }
}
