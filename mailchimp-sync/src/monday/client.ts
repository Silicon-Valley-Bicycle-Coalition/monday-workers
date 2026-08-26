import type { MondayColumnsConfig, DonorRecord } from '../types';

export interface MondayClient {
  getDonorById(itemId: string, columns: MondayColumnsConfig): Promise<DonorRecord | null>;
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
}
