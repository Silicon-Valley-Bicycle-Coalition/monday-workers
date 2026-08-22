import { existsSync } from 'node:fs';
import type { Config } from '../config.js';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from './monday.js';

export const COLUMN_TYPES: Record<string, string> = {
  'SF ID': 'text', 'Email': 'email', 'Secondary Email': 'email', 'Phone': 'phone',
  'Address': 'text', 'City': 'text', 'Zip': 'text', 'Lat': 'text', 'Lng': 'text',
  'Local News': 'link', 'Do Not Solicit': 'checkbox', 'Do Not Solicit Reason': 'text',
  'Email Consent': 'status', 'Membership Status': 'status', 'Membership Tier': 'status',
  'Member Since': 'date', 'Member Until': 'date',
  'Lifetime Giving': 'numbers', 'First Gift': 'date', 'Gift Count': 'numbers',
  'Amount': 'numbers', 'Date': 'date', 'Status': 'status', 'Gift Type': 'text',
  'Funraise ID': 'text', 'Anonymous Donor': 'checkbox',
  'Term Start': 'date', 'Term End': 'date', 'Membership Type': 'text',
  'Partner Type': 'text', 'Website': 'link',
  'Installment Amount': 'numbers', 'Annualized Value': 'numbers', 'Frequency': 'status',
  'Next Payment': 'date', 'Designation': 'text', 'Company Match': 'checkbox', 'Match Employer': 'text',
  'Pledge Amount': 'numbers', 'Received Amount': 'numbers',
  'Attendee Name': 'text', 'Attendee Email': 'text', 'Ticket Amount': 'numbers',
  'Deductible Amount': 'numbers', 'Attended': 'checkbox',
  'Type': 'text', 'Start': 'date', 'End': 'date', 'Active': 'checkbox',
  'Job': 'text', 'Hours': 'numbers', 'Historical': 'checkbox',
  'Activity Type': 'status', 'Owner': 'text', 'From': 'text', 'To': 'text',
  'Employer Name': 'text',
  'Salesforce Created Date': 'date', 'Salesforce Created By': 'text',
  'Salesforce Modified Date': 'date', 'Salesforce Modified By': 'text',
};
export const CONNECT_COLUMNS = new Set(['Donor', 'Organization', 'Recurring Gift', 'Campaign',
  'Attendee', 'Event', 'Payment', 'Volunteer', 'Person']);

// Which logical board(s) each connect column points at, so create_column can pass `defaults`
// with the target board ids — without this, board_relation columns have no connected boards
// configured on the real API and are useless.
export const CONNECT_TARGETS: Record<string, string[] | 'donation-eras'> = {
  'Donor': ['people-live', 'people-historical', 'organizations'],
  'Organization': ['organizations'],
  'Recurring Gift': ['recurring-gifts'],
  'Campaign': ['campaigns'],
  'Attendee': ['people-live', 'people-historical'],
  'Event': ['events'],
  'Payment': 'donation-eras',
  'Volunteer': ['people-live', 'people-historical'],
  'Person': ['people-live', 'people-historical'],
};

export type BoardMap = Record<string, { boardId: number; columns: Record<string, string> }>;

const BOARD_LABELS: Record<string, string> = {
  'people-live': 'People', 'people-historical': 'People (Historical)',
  'organizations': 'Organizations', 'recurring-gifts': 'Recurring Gifts',
  'events': 'Events', 'event-registrations': 'Event Registrations',
  'campaigns': 'Campaigns', 'volunteers': 'Volunteers', 'activities': 'Activities',
};

export async function ensureBoards(
  client: MondayClient, cfg: Config, boardKeys: string[],
  neededColumns: Map<string, Set<string>>, eraLabels: Record<string, string> = {},
): Promise<BoardMap> {
  const path = dataPath('load', 'boards.json');
  const map: BoardMap = existsSync(path) ? await readJson<BoardMap>(path) : {};

  // Pass 1: resolve/create every board id in this run FIRST, with no column work — so pass 2
  // can look up target board ids for board_relation columns regardless of which board in
  // `boardKeys` happens to provision first.
  for (const key of boardKeys) {
    if (map[key]) continue;
    const known = cfg.monday.boards[key];
    let boardId: number;
    if (known) boardId = known;
    else {
      const label = (BOARD_LABELS[key] ?? eraLabels[key] ?? key) + cfg.monday.boardSuffix;
      const res = await client.gql<{ create_board: { id: string } }>(
        `mutation ($name: String!) { create_board (board_name: $name, board_kind: public) { id } }`,
        { name: label });
      boardId = Number(res.create_board.id);
    }
    map[key] = { boardId, columns: {} };
  }

  const resolveTargetBoardIds = (title: string): number[] => {
    const targets = CONNECT_TARGETS[title];
    if (!targets) return [];
    const targetKeys = targets === 'donation-eras'
      ? boardKeys.filter((k) => k.startsWith('donations:'))
      : targets.filter((k) => boardKeys.includes(k));
    return targetKeys.map((k) => map[k]?.boardId).filter((id): id is number => id !== undefined);
  };

  // Pass 2: fetch existing columns, then create anything missing.
  for (const key of boardKeys) {
    const entry = map[key]!;
    const res = await client.gql<{ boards: { columns: { id: string; title: string }[] }[] }>(
      `query ($ids: [ID!]) { boards (ids: $ids) { columns { id title type } } }`,
      { ids: [String(entry.boardId)] });
    for (const col of res.boards[0]?.columns ?? []) entry.columns[col.title] = col.id;

    for (const title of neededColumns.get(key) ?? []) {
      if (entry.columns[title]) continue;
      const isConnect = CONNECT_COLUMNS.has(title);
      const type = isConnect ? 'board_relation' : COLUMN_TYPES[title];
      if (!type) throw new Error(`boards: no COLUMN_TYPES entry for "${title}" — add it`);

      let defaults: string | undefined;
      if (isConnect) {
        const boardIds = resolveTargetBoardIds(title);
        if (boardIds.length > 0) defaults = JSON.stringify({ boardIds });
        else console.warn(`boards: connect column "${title}" on ${key} has no resolvable ` +
          `target boards this run — creating without defaults`);
      }

      const res2 = await client.gql<{ create_column: { id: string } }>(
        `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
           create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults) { id } }`,
        { board: String(entry.boardId), title, type, defaults });
      entry.columns[title] = res2.create_column.id;
    }
  }
  await writeJson(path, map);
  return map;
}
