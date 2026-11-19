// The Journey send log's Monday side: find the People item that holds an address, keep its Last
// Journey Email date, and add a timeline entry (Emails & Activities) for the send.
// The transport's request (src/monday/graphql.ts MondayGraphQL.request), passed in.
export type JourneyLogRequest = <T>(query: string, variables: Record<string, unknown>, options?: { idempotent?: boolean }) => Promise<T>;

export interface TimelineEntry {
  itemId: string;
  customActivityId: string;
  title: string;
  summary: string;
  content: string;
  timestamp: string;
}

export interface JourneyLogMonday {
  // Every item on the board holding the address in any of the columns (deduplicated).
  findPeople(boardId: number, emailColumns: readonly string[], email: string): Promise<string[]>;
  // Sets the date column to `date` (YYYY-MM-DD) unless it already holds a later one. Idempotent.
  advanceDate(boardId: number, itemId: string, columnId: string, date: string): Promise<'set' | 'kept'>;
  createTimelineItem(entry: TimelineEntry): Promise<string>;
}

interface MatchItem { id: string; column_values: { id: string; text: string | null }[] }

export function createJourneyLogMonday(request: JourneyLogRequest): JourneyLogMonday {
  async function exact(boardId: number, columnId: string, values: string[]): Promise<string[]> {
    const data = await request<{ items_page_by_column_values: { items: { id: string }[] } }>(
      `query ($boardId: ID!, $columnId: String!, $values: [String]!) {
        items_page_by_column_values(board_id: $boardId, columns: [{ column_id: $columnId, column_values: $values }], limit: 10) { items { id } }
      }`,
      { boardId, columnId, values },
    );
    return data.items_page_by_column_values.items.map((i) => i.id);
  }

  // items_page_by_column_values matches exact strings; a staff-entered address may be mixed-case.
  // contains_text narrows server-side, then the comparison stays strict (as HttpMondayClient does).
  async function insensitive(boardId: number, columnId: string, email: string): Promise<string[]> {
    const data = await request<{ boards?: { items_page: { items: MatchItem[] } }[] }>(
      `query ($boardId: ID!, $columnId: ID!, $columnIds: [String!], $email: CompareValue!) {
        boards(ids: [$boardId]) {
          items_page(limit: 25, query_params: { rules: [{ column_id: $columnId, compare_value: $email, operator: contains_text }] }) {
            items { id column_values(ids: $columnIds) { id text } }
          }
        }
      }`,
      { boardId, columnId, columnIds: [columnId], email: [email] },
    );
    const wanted = email.trim().toLowerCase();
    return (data.boards?.[0]?.items_page.items ?? [])
      .filter((item) => item.column_values.some((cv) => (cv.text ?? '').trim().toLowerCase() === wanted))
      .map((item) => item.id);
  }

  return {
    async findPeople(boardId, emailColumns, email) {
      const trimmed = email.trim();
      const values = [...new Set([trimmed, trimmed.toLowerCase()])];
      const ids = new Set<string>();
      for (const columnId of emailColumns) for (const id of await exact(boardId, columnId, values)) ids.add(id);
      if (ids.size === 0) {
        for (const columnId of emailColumns) for (const id of await insensitive(boardId, columnId, trimmed)) ids.add(id);
      }
      return [...ids];
    },

    async advanceDate(boardId, itemId, columnId, date) {
      const data = await request<{ items: { column_values: { text: string | null }[] }[] }>(
        `query ($itemId: ID!, $columnIds: [String!]) { items(ids: [$itemId]) { column_values(ids: $columnIds) { text } } }`,
        { itemId, columnIds: [columnId] },
      );
      const current = (data.items[0]?.column_values[0]?.text ?? '').trim().slice(0, 10);
      if (current !== '' && current >= date) return 'kept';
      await request(
        `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
          change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
        }`,
        { boardId, itemId, columnId, value: JSON.stringify({ date }) },
      );
      return 'set';
    },

    async createTimelineItem(entry) {
      const data = await request<{ create_timeline_item: { id: string } }>(
        `mutation ($itemId: ID!, $customActivityId: String!, $title: String!, $summary: String, $content: String, $timestamp: ISO8601DateTime!) {
          create_timeline_item(item_id: $itemId, custom_activity_id: $customActivityId, title: $title, summary: $summary, content: $content, timestamp: $timestamp) { id }
        }`,
        { ...entry },
        // Not idempotent: a create that may have committed throws rather than retrying into a
        // duplicate entry. The row stays pending, and the next run's retry is the rare duplicate.
        { idempotent: false },
      );
      return data.create_timeline_item.id;
    },
  };
}
