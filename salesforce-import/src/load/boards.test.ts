import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatColumnValue } from './columnValues.js';
import { ensureBoards, COLUMN_TYPES, CONNECT_COLUMNS, CONNECT_TARGETS, CURRENCY_COLUMNS } from './boards.js';
import { MondayClient } from './monday.js';
import { loadConfig } from '../config.js';

function scriptedClient(script: { match: RegExp; data: unknown }[]): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const q = JSON.parse((init as { body: string }).body).query as string;
    const hit = script.find((s) => s.match.test(q));
    if (!hit) throw new Error(`no scripted response for: ${q.slice(0, 80)}`);
    return Response.json({ data: hit.data });
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

describe('COLUMN_TYPES', () => {
  it('loads the event-registrations Attendee Email as a real Email column, formatted for Monday', () => {
    expect(COLUMN_TYPES['Attendee Email']).toBe('email');
    expect(formatColumnValue(COLUMN_TYPES['Attendee Email']!, 'ada@svbc.org')).toEqual({ email: 'ada@svbc.org', text: 'ada@svbc.org' });
  });
});

describe('ensureBoards', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates missing boards and columns, persists the map', async () => {
    const client = scriptedClient([
      { match: /create_board/, data: { create_board: { id: '900' } } },
      { match: /boards\s*\(/, data: { boards: [{ columns: [{ id: 'name', title: 'Name', type: 'name' }] }] } },
      { match: /create_column/, data: { create_column: { id: 'col_x' } } },
    ]);
    const cfg = loadConfig();
    const map = await ensureBoards(client, cfg, ['organizations'],
      new Map([['organizations', new Set(['Salesforce Debug', 'Partner Type'])]]));
    expect(map['organizations']!.boardId).toBe(900);
    expect(map['organizations']!.columns['Salesforce Debug']).toBe('col_x');
  });

  it('deletes the placeholder item monday.com seeds on every new board', async () => {
    const deletedIds: string[] = [];
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) {
        return Response.json({
          data: { create_board: { id: '900', items_page: { items: [{ id: 'seed_1' }] } } },
        });
      }
      if (/delete_item/.test(query)) {
        deletedIds.push(variables.id as string);
        return Response.json({ data: { delete_item: { id: variables.id } } });
      }
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    const cfg = loadConfig();
    await ensureBoards(client, cfg, ['organizations'], new Map([['organizations', new Set()]]));

    expect(deletedIds).toEqual(['seed_1']);
  });

  it('board_relation columns are created with defaults pointing at target board ids', async () => {
    // Two boards provisioned in the same run: organizations first (in boardKeys order),
    // then people-live, which needs an 'Organization' connect column pointing back at
    // organizations. Board ids are distinguished by the create_board mutation's $name
    // variable since the generic scriptedClient() helper only dispatches on query text.
    const cfg = loadConfig();
    const boardIdByName: Record<string, string> = {
      [`Organizations${cfg.monday.boardSuffix}`]: '901', [`People${cfg.monday.boardSuffix}`]: '902',
    };
    let orgColumnDefaults: string | undefined;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) {
        return Response.json({ data: { create_board: { id: boardIdByName[variables.name as string] } } });
      }
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        if (variables.title === 'Organization') orgColumnDefaults = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    const map = await ensureBoards(client, cfg, ['organizations', 'people-live'], new Map([
      ['organizations', new Set(['Salesforce Debug'])],
      ['people-live', new Set(['Organization'])],
    ]));

    expect(map['organizations']!.boardId).toBe(901);
    expect(map['people-live']!.boardId).toBe(902);
    expect(orgColumnDefaults).toBeDefined();
    expect(JSON.parse(orgColumnDefaults!).boardIds).toEqual([901]);
  });

  it('currency columns are created with $ unit formatting, not plain numbers', async () => {
    const columnDefaultsByTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '903' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        columnDefaultsByTitle[variables.title as string] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    const cfg = loadConfig();
    await ensureBoards(client, cfg, ['recurring-gifts'],
      new Map([['recurring-gifts', new Set(['Amount', 'Gift Count'])]]));

    expect(JSON.parse(columnDefaultsByTitle['Amount']!)).toEqual({
      unit: { symbol: '$', direction: 'left', precision: 2 },
    });
    expect(columnDefaultsByTitle['Gift Count']).toBeUndefined();
  });

  it('CONNECT_TARGETS declares a target for every connect column', () => {
    for (const title of ['Donor', 'Organization', 'Matched By', 'Recurring Gift', 'Campaign', 'Attendee',
      'Event', 'Payment', 'Volunteer', 'Person']) {
      expect(CONNECT_TARGETS[title], title).toBeDefined();
    }
  });

  it('closed-vocabulary status columns are created with explicit labels, not Monday\'s stock set', async () => {
    const defaultsByTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '970' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        defaultsByTitle[variables.title as string] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    await ensureBoards(client, loadConfig(), ['people-live', 'affiliations'], new Map([
      ['people-live', new Set(['Personal Email Consent', 'Household Email Consent', 'Membership Status', 'Membership Tier'])],
      ['affiliations', new Set(['Status', 'Work Email Consent', 'Attribution'])],
    ]));
    const consent = { 0: 'Subscribed', 1: 'Unsubscribed', 2: 'Cleaned', 3: 'Not in Mailchimp' };
    expect(JSON.parse(defaultsByTitle['Personal Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Household Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Work Email Consent']!).labels).toEqual(consent);
    expect(JSON.parse(defaultsByTitle['Status']!).labels).toEqual({ 0: 'Current', 1: 'Former', 2: 'Draft' });
    expect(JSON.parse(defaultsByTitle['Attribution']!).labels).toEqual(
      { 0: 'Auto', 1: 'Staff', 2: 'Needs review', 3: 'None' });
    expect(JSON.parse(defaultsByTitle['Membership Status']!).labels).toEqual({ 0: 'Active', 1: 'Lapsed' });
  });

  it('seeds the shared Funraise/Eventbrite event vocabularies as closed status sets', async () => {
    const defaultsByTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '980' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        defaultsByTitle[variables.title as string] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    await ensureBoards(client, loadConfig(), ['events', 'event-registrations'], new Map([
      ['events', new Set(['Source', 'Event Status', 'Program', 'Eventbrite ID', 'Eventbrite URL', 'Venue', 'Tickets Sold', 'Funraise Event ID'])],
      ['event-registrations', new Set(['Source', 'Attendance', 'Role', 'Ticket Type', 'Eventbrite Attendee ID'])],
    ]));

    expect(JSON.parse(defaultsByTitle['Source']!).labels).toEqual({ 0: 'Funraise', 1: 'Eventbrite' });
    expect(JSON.parse(defaultsByTitle['Event Status']!).labels).toEqual(
      { 0: 'Upcoming', 1: 'Completed', 2: 'Canceled', 3: 'Draft' });
    expect(JSON.parse(defaultsByTitle['Program']!).labels).toEqual(
      { 0: 'Public', 1: 'Volunteering', 2: 'Bike Parking', 3: 'Group Rides', 4: 'Private', 6: 'Fundraiser' });
    expect(JSON.parse(defaultsByTitle['Attendance']!).labels).toEqual(
      { 0: 'Registered', 1: 'Attended', 2: 'No Show', 3: 'Canceled' });
    expect(JSON.parse(defaultsByTitle['Role']!).labels).toEqual({ 0: 'Participant', 1: 'Volunteer' });
    // Plain columns exist too (would throw "no COLUMN_TYPES entry" otherwise).
    expect(defaultsByTitle).toHaveProperty('Eventbrite URL');
    expect(defaultsByTitle).toHaveProperty('Tickets Sold');
  });

  it('donations "Status" gets its closed vocabulary, but the same title on other boards does not', async () => {
    const defaultsByBoardAndTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) {
        const id = (variables.name as string).startsWith('Recurring Gifts') ? '971' : '972';
        return Response.json({ data: { create_board: { id } } });
      }
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        defaultsByBoardAndTitle[`${variables.board}:${variables.title}`] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    await ensureBoards(client, loadConfig(), ['recurring-gifts', 'donations'], new Map([
      ['recurring-gifts', new Set(['Status'])],
      ['donations', new Set(['Status'])],
    ]));

    expect(defaultsByBoardAndTitle['971:Status']).toBeUndefined();
    expect(JSON.parse(defaultsByBoardAndTitle['972:Status']!).labels).toEqual(
      { 0: 'Received', 1: 'Received (Historical)', 2: 'Failed', 3: 'Pending', 4: 'Closed Lost', 6: 'Pledged' }); // id 5 is the empty-cell slot
  });

  it('Stakeholder Type is created at load with the full docs/22 label set, so configure finds it present (#46)', async () => {
    const defaultsByTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '974' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        defaultsByTitle[variables.title as string] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    // Transform only names the column on elected contacts, but the seeded vocabulary is the whole set.
    await ensureBoards(client, loadConfig(), ['people-live'], new Map([['people-live', new Set(['Stakeholder Type'])]]));

    expect(JSON.parse(defaultsByTitle['Stakeholder Type']!).labels).toEqual(
      { 0: 'Individual Donor', 1: 'City or Agency Staff', 2: 'Elected Official', 3: 'Partner Org Contact' });
  });

  it('Activity Type gets its closed vocabulary', async () => {
    const defaultsByTitle: Record<string, string | undefined> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '973' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        defaultsByTitle[variables.title as string] = variables.defaults as string | undefined;
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    await ensureBoards(client, loadConfig(), ['activities'], new Map([['activities', new Set(['Activity Type'])]]));

    expect(JSON.parse(defaultsByTitle['Activity Type']!).labels).toEqual({ 0: 'Task' });
  });

  it('every transform column title has a declared type', () => {
    // Guard: a new transform column without a COLUMN_TYPES entry must fail loudly here,
    // not silently at load time.
    for (const title of ['Salesforce Debug', 'Personal Email', 'Household Email', 'Work Email',
      'Personal Email Consent', 'Household Email Consent', 'Work Email Consent', 'Household Primary',
      'Affiliation Role', 'Primary', 'Attribution', 'Organizational Giving', 'Attributed Giving',
      'Attributed Gift Count', 'Last Attributed Gift', 'Term Start', 'Lifetime Giving',
      'Annualized Value', 'Historical', 'Stakeholder Type']) {
      expect(COLUMN_TYPES[title], title).toBeDefined();
    }
    for (const title of ['Acting for', 'Affiliations']) {
      expect(CONNECT_COLUMNS.has(title), title).toBe(true);
      expect(CONNECT_TARGETS[title], title).toEqual(['affiliations']);
    }
  });

  it('renames the four People email columns in place instead of creating duplicates', async () => {
    const renamed: { id: string; title: string }[] = [];
    const created: string[] = [];
    const renameCallbacks: [string, string, string][] = [];
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [
        { id: 'email_1', title: 'Email', type: 'email' }, { id: 'email_2', title: 'Secondary Email', type: 'email' },
        { id: 'status_1', title: 'Email Consent', type: 'status' }, { id: 'status_2', title: 'Secondary Email Consent', type: 'status' },
      ] }] } });
      if (/change_column_title/.test(query)) {
        renamed.push({ id: variables.columnId as string, title: variables.title as string });
        return Response.json({ data: { change_column_title: { id: variables.columnId } } });
      }
      if (/create_column/.test(query)) { created.push(variables.title as string); return Response.json({ data: { create_column: { id: `col_${variables.title}` } } }); }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
    const cfg = loadConfig();
    cfg.monday.boards['people-live'] = 4242;   // existing board, so no create_board
    const map = await ensureBoards(client, cfg, ['people-live'], new Map([
      ['people-live', new Set(['Personal Email', 'Household Email', 'Personal Email Consent', 'Household Email Consent', 'Household Primary'])],
    ]), (boardKey, oldTitle, newTitle) => { renameCallbacks.push([boardKey, oldTitle, newTitle]); });
    expect(renamed).toEqual([
      { id: 'email_1', title: 'Personal Email' }, { id: 'email_2', title: 'Household Email' },
      { id: 'status_1', title: 'Personal Email Consent' }, { id: 'status_2', title: 'Household Email Consent' },
    ]);
    expect(created).toEqual(['Household Primary']);
    expect(map['people-live']!.columns['Personal Email']).toBe('email_1');
    expect('Email' in map['people-live']!.columns).toBe(false);
    expect(renameCallbacks).toEqual([
      ['people-live', 'Email', 'Personal Email'],
      ['people-live', 'Secondary Email', 'Household Email'],
      ['people-live', 'Email Consent', 'Personal Email Consent'],
      ['people-live', 'Secondary Email Consent', 'Household Email Consent'],
    ]);
  });
});

describe('ensureBoards workspace targeting', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates boards inside monday.workspaceId when configured', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) {
        captured = variables;
        if (!/workspace_id/.test(query)) throw new Error('create_board mutation missing workspace_id');
        return Response.json({ data: { create_board: { id: '950' } } });
      }
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: 'col_x' } } });
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    const cfg = loadConfig();
    cfg.monday.workspaceId = 10001654;
    const map = await ensureBoards(client, cfg, ['organizations'],
      new Map([['organizations', new Set(['Salesforce Debug'])]]));

    expect(map['organizations']!.boardId).toBe(950);
    expect(captured?.workspaceId).toBe('10001654');
  });
});

describe('ensureBoards column ordering', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates the Salesforce Debug column last so it sits at the far right of the board', async () => {
    const createdTitles: string[] = [];
    const fetchFn = (async (_u: unknown, init: unknown) => {
      const { query, variables } = JSON.parse((init as { body: string }).body);
      if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '960' } } });
      if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
      if (/create_column/.test(query)) {
        createdTitles.push(variables.title as string);
        return Response.json({ data: { create_column: { id: `col_${variables.title}` } } });
      }
      throw new Error(`no scripted response for: ${String(query).slice(0, 80)}`);
    }) as typeof fetch;
    const client = new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });

    await ensureBoards(client, loadConfig(), ['organizations'],
      new Map([['organizations', new Set(['Salesforce Debug', 'Partner Type', 'Website'])]]));

    expect(createdTitles).toEqual(['Partner Type', 'Website', 'Salesforce Debug']);
  });
});
