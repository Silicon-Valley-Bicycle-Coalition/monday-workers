import type { MondayColumnsConfig, DonorRecord } from '../types';

export interface MondayClient {
  getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null>;
  createCampaignItem(boardId: number, name: string): Promise<string>;
  renameItem(boardId: number, itemId: string, name: string): Promise<void>;
  archiveItem(itemId: string): Promise<void>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class HttpMondayClient implements MondayClient {
  constructor(
    private apiUrl: string,
    private apiToken: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`monday: HTTP ${response.status}`);
    }
    const json = (await response.json()) as GraphQLResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`monday: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data as T;
  }

  async getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null> {
    const columnIds = [
      columns.email, columns.membershipStatus, columns.membershipTier,
      columns.memberSince, columns.memberUntil, columns.addr1, columns.city,
      columns.state, columns.zip, columns.totalGiven,
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
}
