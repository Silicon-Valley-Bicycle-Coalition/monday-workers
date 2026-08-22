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
  'Employer Match Status': 'text', 'Employer Name': 'text',
  'Salesforce Created Date': 'date', 'Salesforce Created By': 'text',
  'Salesforce Modified Date': 'date', 'Salesforce Modified By': 'text',
};
export const CONNECT_COLUMNS = new Set(['Donor', 'Organization', 'Recurring Gift', 'Campaign',
  'Attendee', 'Event', 'Payment', 'Volunteer', 'Person']);

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

  for (const key of boardKeys) {
    if (!map[key]) {
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
    const entry = map[key]!;
    const res = await client.gql<{ boards: { columns: { id: string; title: string }[] }[] }>(
      `query ($ids: [ID!]) { boards (ids: $ids) { columns { id title type } } }`,
      { ids: [String(entry.boardId)] });
    for (const col of res.boards[0]?.columns ?? []) entry.columns[col.title] = col.id;

    for (const title of neededColumns.get(key) ?? []) {
      if (entry.columns[title]) continue;
      const type = CONNECT_COLUMNS.has(title) ? 'board_relation' : COLUMN_TYPES[title];
      if (!type) throw new Error(`boards: no COLUMN_TYPES entry for "${title}" — add it`);
      const res2 = await client.gql<{ create_column: { id: string } }>(
        `mutation ($board: ID!, $title: String!, $type: ColumnType!) {
           create_column (board_id: $board, title: $title, column_type: $type) { id } }`,
        { board: String(entry.boardId), title, type });
      entry.columns[title] = res2.create_column.id;
    }
  }
  await writeJson(path, map);
  return map;
}
