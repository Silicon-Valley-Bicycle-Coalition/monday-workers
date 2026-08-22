import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from './index.js';
import { writeNdjson, writeJson, dataPath } from '../artifacts.js';
import { Ledger } from './ledger.js';
import { MondayClient } from './monday.js';

let created: { name: string; board: number }[];
let linked: string[];

function fakeClient(failFor: Set<string> = new Set()): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '900' } } });
    if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
    if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: `c_${Math.random().toString(36).slice(2, 8)}` } } });
    if (/create_item/.test(query)) {
      const name = variables.itemName as string;
      if (failFor.has(name)) return Response.json({ errors: [{ message: `boom: ${name}` }] });
      created.push({ name, board: Number(variables.boardId) });
      return Response.json({ data: { create_item: { id: String(100 + created.length) } } });
    }
    if (/change_multiple_column_values/.test(query)) {
      linked.push(variables.itemId as string);
      return Response.json({ data: { change_multiple_column_values: { id: variables.itemId } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

async function seed() {
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'SF ID': 'a1' } },
    { board: 'people-live', sfId: 'c1', name: 'Ada', columns: { 'SF ID': 'c1' },
      links: [{ column: 'Organization', targetSfIds: ['a1'] }] },
    { board: 'donations:live', sfId: 'o1', name: 'Gift', columns: { 'SF ID': 'o1' },
      links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
  ]);
  await writeJson(dataPath('transform', 'eras.json'),
    [{ key: 'donations:live', label: 'Donations', startYear: 2024, endYear: null }]);
}

describe('runLoad', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await seed();
  });

  it('creates items in dependency order then links', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // orgs before people before donations
    expect(linked.length).toBe(2);
  });

  it('dry-run writes nothing', async () => {
    expect(await runLoad(['--dry-run'], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]);
  });

  it('failures are ledgered, exit 1, and only failures retry on re-run', async () => {
    expect(await runLoad([], { client: fakeClient(new Set(['Gift'])) })).toBe(1);
    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']);

    created = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Gift']); // Acme/Ada skipped via ledger
  });
});
