// src/monday.ts
import type { Member, MondayColumns } from './types';

interface MondayColumnValue {
  id: string;
  text: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}

function columnText(item: MondayItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? '';
}

export function toMember(item: MondayItem, columns: MondayColumns): Member {
  return {
    id: item.id,
    name: item.name,
    email: columnText(item, columns.email),
    membershipStatus: columnText(item, columns.membershipStatus),
    membershipTier: columnText(item, columns.membershipTier),
    memberUntil: columnText(item, columns.memberUntil),
    remindersSent: columnText(item, columns.remindersSent),
  };
}

export class MondayClient {
  constructor(
    private apiUrl: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.token,
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

  async queryDueMembers(
    boardId: number,
    columns: MondayColumns,
    activeStatusValue: string,
    targetDateISO: string,
  ): Promise<Member[]> {
    // NOTE: verify this query_params shape against Monday's current GraphQL API docs once the
    // sandbox Donors board exists — the exact rule syntax for status/date columns has changed
    // across Monday API versions.
    const columnIds = JSON.stringify([
      columns.email,
      columns.membershipTier,
      columns.memberUntil,
      columns.remindersSent,
      columns.membershipStatus,
    ]);

    const firstPageQuery = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(
            limit: 500,
            query_params: {
              rules: [
                { column_id: "${columns.membershipStatus}", compare_value: ["${activeStatusValue}"], operator: any_of },
                { column_id: "${columns.memberUntil}", compare_value: ["${targetDateISO}"], operator: any_of }
              ]
            }
          ) {
            cursor
            items {
              id
              name
              column_values(ids: ${columnIds}) {
                id
                text
              }
            }
          }
        }
      }
    `;

    const nextPageQuery = `
      query ($cursor: String!) {
        next_items_page(cursor: $cursor, limit: 500) {
          cursor
          items {
            id
            name
            column_values(ids: ${columnIds}) {
              id
              text
            }
          }
        }
      }
    `;

    const firstData = await this.request<{
      boards: { items_page: { cursor: string | null; items: MondayItem[] } }[];
    }>(firstPageQuery, { boardId });
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

    return allItems.map((item) => toMember(item, columns));
  }

  async stampReminderSent(
    itemId: string,
    boardId: number,
    columnId: string,
    newValue: string,
  ): Promise<void> {
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) {
          id
        }
      }
    `;
    await this.request(mutation, { boardId, itemId, columnId, value: newValue });
  }
}
