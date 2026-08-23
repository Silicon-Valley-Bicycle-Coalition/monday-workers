import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBoards, COLUMN_TYPES, CONNECT_TARGETS } from './boards.js';
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
      new Map([['organizations', new Set(['SF ID', 'Partner Type'])]]));
    expect(map['organizations']!.boardId).toBe(900);
    expect(map['organizations']!.columns['SF ID']).toBe('col_x');
  });

  it('board_relation columns are created with defaults pointing at target board ids', async () => {
    // Two boards provisioned in the same run: organizations first (in boardKeys order),
    // then people-live, which needs an 'Organization' connect column pointing back at
    // organizations. Board ids are distinguished by the create_board mutation's $name
    // variable since the generic scriptedClient() helper only dispatches on query text.
    const boardIdByName: Record<string, string> = { Organizations: '901', People: '902' };
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

    const cfg = loadConfig();
    const map = await ensureBoards(client, cfg, ['organizations', 'people-live'], new Map([
      ['organizations', new Set(['SF ID'])],
      ['people-live', new Set(['Organization'])],
    ]));

    expect(map['organizations']!.boardId).toBe(901);
    expect(map['people-live']!.boardId).toBe(902);
    expect(orgColumnDefaults).toBeDefined();
    expect(JSON.parse(orgColumnDefaults!).boardIds).toEqual([901]);
  });

  it('CONNECT_TARGETS declares a target for every connect column', () => {
    for (const title of ['Donor', 'Organization', 'Recurring Gift', 'Campaign', 'Attendee',
      'Event', 'Payment', 'Volunteer', 'Person']) {
      expect(CONNECT_TARGETS[title], title).toBeDefined();
    }
  });

  it('every transform column title has a declared type', () => {
    // Guard: a new transform column without a COLUMN_TYPES entry must fail loudly here,
    // not silently at load time.
    for (const title of ['SF ID', 'Email Consent', 'Term Start', 'Lifetime Giving',
      'Salesforce Created Date', 'Salesforce Modified By', 'Annualized Value', 'Historical']) {
      expect(COLUMN_TYPES[title], title).toBeDefined();
    }
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
      new Map([['organizations', new Set(['SF ID'])]]));

    expect(map['organizations']!.boardId).toBe(950);
    expect(captured?.workspaceId).toBe('10001654');
  });
});

describe('ensureBoards column ordering', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('creates debug columns (SF ID) last so they sit at the far right of the board', async () => {
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
      new Map([['organizations', new Set(['SF ID', 'Partner Type', 'Website'])]]));

    expect(createdTitles).toEqual(['Partner Type', 'Website', 'SF ID']);
  });
});
