import { existsSync } from 'node:fs';
import type { Config } from '../config.js';
import { dataPath, readJson, writeJson } from '../artifacts.js';
import type { MondayClient } from './monday.js';

// 'Fiscal Year Ending' is deliberately 'text', not 'numbers': Monday renders every numbers
// column with a thousands separator, so FY2025 displayed as "2,025" in the sandbox. A 4-digit
// year sorts correctly as text, and the title says which end of SVBC's July–June year it names.
export const COLUMN_TYPES: Record<string, string> = {
  'Salesforce Debug': 'long_text',
  'Personal Email': 'email', 'Household Email': 'email', 'Work Email': 'email', 'Phone': 'phone',
  'Address': 'text', 'City': 'text', 'Zip': 'text', 'Lat': 'text', 'Lng': 'text',
  'Do Not Solicit': 'checkbox', 'Do Not Solicit Reason': 'text',
  'Personal Email Consent': 'status', 'Household Email Consent': 'status', 'Work Email Consent': 'status',
  'Household Primary': 'checkbox', 'Primary': 'checkbox', 'Affiliation Role': 'text', 'Attribution': 'status',
  'Organizational Giving': 'numbers', 'Attributed Giving': 'numbers',
  'Attributed Gift Count': 'numbers', 'Last Attributed Gift': 'date',
  'Membership Status': 'status', 'Membership Tier': 'status',
  'Member Since': 'date', 'Member Until': 'date',
  'Lifetime Giving': 'numbers', 'First Gift': 'date', 'Gift Count': 'numbers',
  'Amount': 'numbers', 'Date': 'date', 'Fiscal Year Ending': 'text', 'Status': 'status', 'Gift Type': 'text',
  'Funraise ID': 'link', 'Funraise Profile': 'link', 'Anonymous Donor': 'checkbox',
  'Benevity Transaction ID': 'text',
  'Term Start': 'date', 'Term End': 'date', 'Membership Type': 'text',
  'Partner Type': 'text', 'Website': 'link',
  'Installment Amount': 'numbers', 'Annualized Value': 'numbers', 'Frequency': 'status',
  'Next Payment': 'date', 'Designation': 'text', 'Company Match': 'checkbox', 'Match Employer': 'text',
  'Pledge Amount': 'numbers', 'Received Amount': 'numbers',
  'Attendee Name': 'text', 'Attendee Email': 'text', 'Ticket Amount': 'numbers',
  'Deductible Amount': 'numbers', 'Ticket Type': 'text', 'Eventbrite Attendee ID': 'text',
  'Source': 'status', 'Attendance': 'status', 'Role': 'status', 'Event Status': 'status', 'Program': 'status',
  'Venue': 'text', 'Tickets Sold': 'numbers', 'Eventbrite ID': 'text', 'Eventbrite URL': 'link',
  'Funraise Event ID': 'text',
  'Type': 'text', 'Start': 'date', 'End': 'date', 'Active': 'checkbox',
  'Job': 'text', 'Hours': 'numbers', 'Historical': 'checkbox',
  'Activity Type': 'status', 'Owner': 'text', 'From': 'text', 'To': 'text',
  'Employer Name': 'text', 'Salesforce Owner': 'text',
};
export const CONNECT_COLUMNS = new Set(['Donor', 'Organization', 'Matched By', 'Recurring Gift', 'Campaign',
  'Attendee', 'Event', 'Payment', 'Volunteer', 'Person', 'Acting for', 'Affiliations']);
// Closed-vocabulary status columns: passed as create_column `defaults` so Monday seeds the
// column with exactly these labels. Without this, a new status column gets Monday's stock
// "Working on it / Done / Stuck" set, which nothing ever clears — it just sits in the
// dropdown forever alongside the real values written later.
const CONSENT_LABELS = ['Subscribed', 'Unsubscribed', 'Cleaned', 'Not in Mailchimp'];
export const STATUS_LABELS: Record<string, string[]> = {
  'Personal Email Consent': CONSENT_LABELS,
  'Household Email Consent': CONSENT_LABELS,
  'Work Email Consent': CONSENT_LABELS,
  'Attribution': ['Auto', 'Staff', 'Needs review', 'None'],
  'Membership Status': ['Active', 'Lapsed'],
  'Membership Tier': ['Lifetime', 'Member'],
  'Activity Type': ['Task'],
  // Events / Event Registrations — shared by the Funraise and Eventbrite transforms (boards.ts).
  // Attendance mirrors the production Event Participation board's Attended/Registered/No Show,
  // plus Canceled for Eventbrite's Not Attending; No Show is never set by the import (the data
  // can't tell a no-show from a registrant at an event that never took check-in) — staff set it.
  'Source': ['Funraise', 'Eventbrite'],
  'Event Status': ['Upcoming', 'Completed', 'Canceled', 'Draft'],
  'Program': ['Public', 'Volunteering', 'Bike Parking', 'Group Rides', 'Private', 'Fundraiser'],
  'Attendance': ['Registered', 'Attended', 'No Show', 'Canceled'],
  'Role': ['Participant', 'Volunteer'],
};
// "Status" isn't in STATUS_LABELS above because the title is reused across boards with
// unrelated vocabularies: Recurring Gifts and Volunteers/Activities pass raw values through
// from Funraise/the Volunteers app/Salesforce Task, which aren't closed sets known to this
// code. Only the Donations board computes "Status" itself (StageName mapped to exactly
// Received/Failed/Pending in transform/donations.ts), so that one is closed and scoped by
// board key rather than title alone.
const DONATION_STATUS_LABELS = ['Received', 'Received (Historical)', 'Failed', 'Pending'];
// The design spec adds a 'Draft' state for affiliations a later Worker proposes and staff have
// not yet confirmed, alongside the two settled states.
const AFFILIATION_STATUS_LABELS = ['Current', 'Former', 'Draft'];

function statusLabelsFor(key: string, title: string): string[] | undefined {
  if (title === 'Status' && key === 'donations') return DONATION_STATUS_LABELS;
  if (title === 'Status' && key === 'affiliations') return AFFILIATION_STATUS_LABELS;
  return STATUS_LABELS[title];
}
// Needed for debugging/reconciliation during the migration, deleted afterward — created
// last so they sit at the far right of every board instead of next to the item name.
export const DEBUG_COLUMNS = new Set(['Salesforce Debug']);

// Dollar-amount 'numbers' columns — created with currency (not plain float) formatting.
// 'Gift Count' and 'Hours' are 'numbers' too but aren't money, so they're excluded.
export const CURRENCY_COLUMNS = new Set(['Lifetime Giving', 'Amount', 'Installment Amount',
  'Annualized Value', 'Pledge Amount', 'Received Amount', 'Ticket Amount', 'Deductible Amount',
  'Organizational Giving', 'Attributed Giving']);
const CURRENCY_DEFAULTS = JSON.stringify({ unit: { symbol: '$', direction: 'left', precision: 2 } });

// Which logical board(s) each connect column points at, so create_column can pass `defaults`
// with the target board ids — without this, board_relation columns have no connected boards
// configured on the real API and are useless.
export const CONNECT_TARGETS: Record<string, string[]> = {
  'Donor': ['people-live', 'people-historical', 'organizations'],
  'Organization': ['organizations'],
  'Matched By': ['organizations'],
  'Recurring Gift': ['recurring-gifts'],
  'Campaign': ['campaigns'],
  'Attendee': ['people-live', 'people-historical'],
  'Event': ['events'],
  'Payment': ['donations'],
  'Volunteer': ['people-live', 'people-historical'],
  'Person': ['people-live', 'people-historical'],
  'Acting for': ['affiliations'], 'Affiliations': ['affiliations'],
};

export type BoardMap = Record<string, { boardId: number; columns: Record<string, string> }>;

const PEOPLE_EMAIL_RENAMES: Record<string, string> = {
  'Email': 'Personal Email', 'Secondary Email': 'Household Email',
  'Email Consent': 'Personal Email Consent', 'Secondary Email Consent': 'Household Email Consent',
};
// Titles that changed meaning after the sandbox boards were first provisioned. Renaming keeps the
// column id (and every value already on it) instead of leaving an orphan next to a fresh empty
// column. Keyed by board so an unrelated board with an "Email" column is never touched.
export const COLUMN_RENAMES: Record<string, Record<string, string>> = {
  'people-live': PEOPLE_EMAIL_RENAMES,
  'people-historical': PEOPLE_EMAIL_RENAMES,
};

const BOARD_LABELS: Record<string, string> = {
  'donations': 'Donations',
  'people-live': 'People', 'people-historical': 'People (Historical)',
  'organizations': 'Organizations', 'recurring-gifts': 'Recurring Gifts',
  'events': 'Events', 'event-registrations': 'Event Registrations',
  'campaigns': 'Campaigns', 'volunteers': 'Volunteers', 'activities': 'Activities',
  'affiliations': 'Affiliations',
};

export async function ensureBoards(
  client: MondayClient, cfg: Config, boardKeys: string[],
  neededColumns: Map<string, Set<string>>,
  onRename: (boardKey: string, oldTitle: string, newTitle: string) => void = () => {},
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
      const label = (BOARD_LABELS[key] ?? key) + cfg.monday.boardSuffix;
      // Without workspace_id, create_board targets the account's Main workspace, which
      // SVBC restricts (403 even for admins) — boards must be created in a named workspace.
      const workspaceId = cfg.monday.workspaceId ?? null;
      const res = workspaceId
        ? await client.gql<{ create_board: { id: string; items_page: { items: { id: string }[] } } }>(
            `mutation ($name: String!, $workspaceId: ID!) {
               create_board (board_name: $name, board_kind: public, workspace_id: $workspaceId) {
                 id
                 items_page (limit: 25) { items { id } }
               } }`,
            { name: label, workspaceId: String(workspaceId) })
        : await client.gql<{ create_board: { id: string; items_page: { items: { id: string }[] } } }>(
            `mutation ($name: String!) {
               create_board (board_name: $name, board_kind: public) {
                 id
                 items_page (limit: 25) { items { id } }
               } }`,
            { name: label });
      boardId = Number(res.create_board.id);

      // monday.com seeds every new board with a placeholder item ("Task 1") in its default
      // group. Delete it immediately, before any real data lands, so it never lingers.
      for (const item of res.create_board.items_page?.items ?? []) {
        await client.gql(`mutation ($id: ID!) { delete_item (item_id: $id) { id } }`, { id: item.id });
      }
    }
    map[key] = { boardId, columns: {} };
  }

  const resolveTargetBoardIds = (title: string): number[] => {
    const targetKeys = (CONNECT_TARGETS[title] ?? []).filter((k) => boardKeys.includes(k));
    return targetKeys.map((k) => map[k]?.boardId).filter((id): id is number => id !== undefined);
  };

  // Pass 2: fetch existing columns, then create anything missing.
  for (const key of boardKeys) {
    const entry = map[key]!;
    const res = await client.gql<{ boards: { columns: { id: string; title: string }[] }[] }>(
      `query ($ids: [ID!]) { boards (ids: $ids) { columns { id title type } } }`,
      { ids: [String(entry.boardId)] });
    for (const col of res.boards[0]?.columns ?? []) entry.columns[col.title] = col.id;

    for (const [oldTitle, newTitle] of Object.entries(COLUMN_RENAMES[key] ?? {})) {
      const id = entry.columns[oldTitle];
      if (!id || entry.columns[newTitle]) continue;   // nothing to rename, or already done
      await client.gql(
        `mutation ($board: ID!, $columnId: String!, $title: String!) {
           change_column_title (board_id: $board, column_id: $columnId, title: $title) { id } }`,
        { board: String(entry.boardId), columnId: id, title: newTitle });
      entry.columns[newTitle] = id;
      delete entry.columns[oldTitle];
      onRename(key, oldTitle, newTitle);
    }

    // Debug columns go last so they land at the far right of the board — staff-facing
    // columns stay prominent, and Salesforce Debug is slated for deletion after the migration.
    const ordered = [...(neededColumns.get(key) ?? [])]
      .sort((a, b) => Number(DEBUG_COLUMNS.has(a)) - Number(DEBUG_COLUMNS.has(b)));
    for (const title of ordered) {
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
      } else if (CURRENCY_COLUMNS.has(title)) {
        defaults = CURRENCY_DEFAULTS;
      } else {
        const labels = statusLabelsFor(key, title);
        if (labels) defaults = JSON.stringify({ labels: Object.fromEntries(labels.map((label, i) => [i, label])) });
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
