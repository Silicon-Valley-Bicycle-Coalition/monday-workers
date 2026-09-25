// Minimal Monday GraphQL client for pulling contact coordinates off a board — just enough for
// this one-off tool, not a general SDK. Mirrors the graphql() helper other one-off scripts in
// this monorepo use (e.g. salesforce-import's scripts/create-letter-settings-board.mjs).

import type { Contact } from './geometry.js';

const API_URL = 'https://api.monday.com/v2';

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2026-01' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`monday API: ${json.errors.map((e: { message: string }) => e.message).join('; ')}`);
  if (!json.data) throw new Error(`monday API: no data — ${JSON.stringify(json)}`);
  return json.data;
}

export interface ColumnTitles {
  /**
   * Title of the column to report as each contact's name. Undefined means the item's own name
   * (Monday's built-in `name` column, whatever it's titled) — the right default for Donors.
   */
  name?: string;
  lat: string;
  lng: string;
  zip: string;
}

// Monday's fixed column id for an item's own name, whatever the board titles it.
const ITEM_NAME_COLUMN_ID = 'name';

// Resolves each configured column title to its id (titles are what a human picks on the CLI;
// ids are what the API actually needs), then pages through every item on the board.
export async function fetchContacts(token: string, boardId: string, columns: ColumnTitles): Promise<Contact[]> {
  const boardData = await graphql(token, `query ($boardId: [ID!]) { boards(ids: $boardId) { columns { id title } } }`, { boardId: [boardId] });
  const byTitle = new Map<string, string>((boardData.boards[0]?.columns ?? []).map((c: { id: string; title: string }) => [c.title, c.id]));
  const latId = byTitle.get(columns.lat);
  const lngId = byTitle.get(columns.lng);
  const zipId = byTitle.get(columns.zip);
  const nameId = columns.name === undefined ? ITEM_NAME_COLUMN_ID : byTitle.get(columns.name);
  if (!latId || !lngId || !zipId || !nameId) {
    const missing = [
      !latId && `lat column "${columns.lat}"`,
      !lngId && `lng column "${columns.lng}"`,
      !zipId && `zip column "${columns.zip}"`,
      !nameId && `name column "${columns.name}"`,
    ].filter(Boolean);
    throw new Error(`fetchContacts: board ${boardId} is missing ${missing.join(', ')} — pass --lat-column/--lng-column/--zip-column/--name-column to match the real titles.`);
  }
  // The item name comes back on every item already; any other name column has to be requested.
  const colIds = nameId === ITEM_NAME_COLUMN_ID ? [latId, lngId, zipId] : [latId, lngId, zipId, nameId];

  const contacts: Contact[] = [];
  let cursor: string | null = null;
  do {
    const page: any = cursor
      ? await graphql(
          token,
          `query ($cursor: String!, $colIds: [String!]) {
            next_items_page(cursor: $cursor, limit: 500) {
              cursor
              items { id name column_values(ids: $colIds) { id text } }
            }
          }`,
          { cursor, colIds }
        )
      : await graphql(
          token,
          `query ($boardId: ID!, $colIds: [String!]) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items { id name column_values(ids: $colIds) { id text } }
              }
            }
          }`,
          { boardId, colIds }
        );
    const itemsPage: any = cursor ? page.next_items_page : page.boards[0].items_page;
    for (const item of itemsPage.items) {
      const byColId = new Map(item.column_values.map((cv: { id: string; text: string | null }) => [cv.id, cv.text]));
      const latText = byColId.get(latId) as string | null;
      const lngText = byColId.get(lngId) as string | null;
      const lat = latText ? Number(latText) : NaN;
      const lng = lngText ? Number(lngText) : NaN;
      const nameText = nameId === ITEM_NAME_COLUMN_ID ? null : ((byColId.get(nameId) as string | null) || '').trim();
      contacts.push({
        id: item.id,
        // A blank name cell falls back to the item name rather than an empty CSV cell.
        name: nameText || item.name,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        zip: ((byColId.get(zipId) as string | null) || '').trim() || null,
      });
    }
    cursor = itemsPage.cursor;
  } while (cursor);

  return contacts;
}
