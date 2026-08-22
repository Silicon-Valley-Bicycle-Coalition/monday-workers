import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBoards, COLUMN_TYPES } from './boards.js';
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

  it('every transform column title has a declared type', () => {
    // Guard: a new transform column without a COLUMN_TYPES entry must fail loudly here,
    // not silently at load time.
    for (const title of ['SF ID', 'Email Consent', 'Term Start', 'Lifetime Giving', 'Local News',
      'Salesforce Created Date', 'Salesforce Modified By', 'Annualized Value', 'Historical']) {
      expect(COLUMN_TYPES[title], title).toBeDefined();
    }
  });
});
