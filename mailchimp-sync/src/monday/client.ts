import type { MondayColumnsConfig, DonorRecord } from '../types';
import { parseRetryAfter, retryAfterHeader } from '../retryAfter';

export interface MondayClient {
  getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null>;
  createCampaignItem(boardId: number, name: string): Promise<string>;
  renameItem(boardId: number, itemId: string, name: string): Promise<void>;
  archiveItem(itemId: string): Promise<void>;
  findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null>;
  setConnectColumn(boardId: number, itemId: string, columnId: string, linkedItemIds: string[]): Promise<void>;
}

const MONDAY_API_VERSION = '2026-01';

interface GraphQLError {
  message: string;
  // Monday puts the machine-readable code (COMPLEXITY_BUDGET_EXHAUSTED, RATE_LIMIT_EXCEEDED,
  // DAILY_LIMIT_EXCEEDED, …) and, for rate limits, retry_in_seconds here.
  extensions?: { code?: unknown; error_code?: unknown; retry_in_seconds?: unknown };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  // Monday's legacy rate-limit / auth-failure shape: no data and no errors array.
  error_message?: string;
  error_code?: string;
  status_code?: number;
}

// Carries what the queue consumer needs to pick a retry delay: the HTTP status, Monday's error
// code, and how long Monday asked us to wait (whole seconds) when it said.
export class MondayApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string | undefined,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
  }
}

function finiteSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function mondayError(message: string, httpStatus: number, json: GraphQLResponse<unknown> | undefined, retryAfter: string | null): MondayApiError {
  let code: string | undefined;
  let retryAfterSeconds: number | undefined;
  for (const e of json?.errors ?? []) {
    const c = e.extensions?.code ?? e.extensions?.error_code;
    if (code === undefined && typeof c === 'string') code = c;
    retryAfterSeconds ??= finiteSeconds(e.extensions?.retry_in_seconds);
  }
  if (code === undefined && typeof json?.error_code === 'string') code = json.error_code;
  // Legacy complexity errors only say it in prose: "… reset in 13 seconds".
  const legacyReset = typeof json?.error_message === 'string' ? /reset in (\d+) seconds?/i.exec(json.error_message) : null;
  if (legacyReset) retryAfterSeconds ??= Number(legacyReset[1]);
  retryAfterSeconds ??= parseRetryAfter(retryAfter);
  return new MondayApiError(message, httpStatus, code, retryAfterSeconds);
}

async function readJson(response: Response): Promise<GraphQLResponse<unknown> | undefined> {
  try {
    return (await response.json()) as GraphQLResponse<unknown>;
  } catch {
    return undefined;
  }
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    // Bound to globalThis: called as `this.fetchFn(...)` below, and an unbound native
    // `fetch` throws "Illegal invocation" when invoked with `this` set to something other
    // than the global scope. Invisible in unit tests (they inject a plain mock function,
    // which doesn't care about `this`) — only surfaced provisioning the sandbox 2026-09-22.
    private fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiToken,
        'API-Version': MONDAY_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    const retryAfter = retryAfterHeader(response);
    if (!response.ok) {
      // Monday's 429s (and some 4xx/5xx) still carry a GraphQL error body with the code and
      // retry_in_seconds — read it so the consumer can honor the hint.
      const body = await readJson(response);
      const messages = body?.errors?.map((e) => e.message).join('; ') ?? body?.error_message;
      throw mondayError(`monday: HTTP ${response.status}${messages ? `: ${messages}` : ''}`, response.status, body, retryAfter);
    }
    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw mondayError(`monday: ${json.errors.map((e) => e.message).join('; ')}`, response.status, json, retryAfter);
    }
    if (!json.data) {
      // Without this, `json.data` is undefined and the caller fails downstream with something
      // like "Cannot read properties of undefined" instead of the server's actual message.
      const detail =
        typeof json.error_message === 'string'
          ? `${json.error_message}${json.status_code === undefined ? '' : ` (status_code ${json.status_code})`}`
          : JSON.stringify(json);
      throw mondayError(`monday: response contained no data — ${detail}`, json.status_code ?? response.status, json, retryAfter);
    }
    return json.data;
  }

  async getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null> {
    const columnIds = [
      columns.email, columns.membershipStatus, columns.membershipTier,
      columns.memberSince, columns.memberUntil, columns.addr1, columns.city,
      columns.state, columns.zip, columns.totalGiven, columns.doNotSolicit, columns.dnsReasonStatus,
    ];
    const data = await this.graphql<{ items: { id: string; column_values: { id: string; text: string | null }[] }[] }>(
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
    const data = await this.graphql<{ create_item: { id: string } }>(
      `mutation ($boardId: ID!, $name: String!) {
        create_item(board_id: $boardId, item_name: $name) { id }
      }`,
      { boardId, name },
    );
    return data.create_item.id;
  }

  // Monday's item name isn't editable via a normal column mutation, but the item
  // schema treats "name" itself as a simple-value column with id "name" — a
  // documented, commonly-used trick, not a real user-defined column. Verify against
  // Monday's current API docs if this ever starts failing.
  async renameItem(boardId: number, itemId: string, name: string): Promise<void> {
    await this.graphql(
      `mutation ($boardId: ID!, $itemId: ID!, $name: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: "name", value: $name) { id }
      }`,
      { boardId, itemId, name },
    );
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.graphql(
      `mutation ($itemId: ID!) { archive_item(item_id: $itemId) { id } }`,
      { itemId },
    );
  }

  // Text-column filtering is supported by Monday's API — donation-rollups hit a wall
  // specifically with board_relation columns, not plain text ones, so this is safe.
  async findItemIdByEmail(boardId: number, emailColumnId: string, email: string): Promise<string | null> {
    const data = await this.graphql<{ items_page_by_column_values: { items: { id: string }[] } }>(
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
    const data = await this.graphql<{
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
    await this.graphql(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
      }`,
      { boardId, itemId, columnId, value: JSON.stringify({ item_ids: linkedItemIds.map(Number) }) },
    );
  }
}
