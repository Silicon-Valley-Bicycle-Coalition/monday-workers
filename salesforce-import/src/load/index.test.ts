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
let createItemVariables: Record<string, unknown>[];
let linkVariables: Record<string, unknown>[];

function fakeClient(failFor: Set<string> = new Set(), failLinksFor: Set<string> = new Set()): MondayClient {
  const fetchFn = (async (_u: unknown, init: unknown) => {
    const { query, variables } = JSON.parse((init as { body: string }).body);
    if (/create_board/.test(query)) return Response.json({ data: { create_board: { id: '900' } } });
    if (/boards\s*\(/.test(query)) return Response.json({ data: { boards: [{ columns: [] }] } });
    if (/create_column/.test(query)) return Response.json({ data: { create_column: { id: `c_${Math.random().toString(36).slice(2, 8)}` } } });
    if (/create_item/.test(query)) {
      createItemVariables.push(variables);
      const name = variables.itemName as string;
      if (failFor.has(name)) return Response.json({ errors: [{ message: `boom: ${name}` }] });
      created.push({ name, board: Number(variables.boardId) });
      return Response.json({ data: { create_item: { id: String(100 + created.length) } } });
    }
    if (/change_multiple_column_values/.test(query)) {
      linkVariables.push(variables);
      const itemId = variables.itemId as string;
      if (failLinksFor.has(itemId)) return Response.json({ errors: [{ message: `link boom: ${itemId}` }] });
      linked.push(itemId);
      return Response.json({ data: { change_multiple_column_values: { id: itemId } } });
    }
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  }) as typeof fetch;
  return new MondayClient({ apiUrl: 'https://x', token: 't', fetchFn, sleepFn: async () => {} });
}

async function seed() {
  await writeNdjson(dataPath('transform', 'payloads.ndjson'), [
    { board: 'organizations', sfId: 'a1', name: 'Acme', columns: { 'Salesforce Debug': { text: 'SF ID: a1' } } },
    { board: 'people-live', sfId: 'c1', name: 'Ada', columns: { 'Salesforce Debug': { text: 'SF ID: c1' } },
      links: [{ column: 'Organization', targetSfIds: ['a1'] }] },
    { board: 'donations:live', sfId: 'o1', name: 'Gift', columns: { 'Salesforce Debug': { text: 'SF ID: o1' } },
      links: [{ column: 'Donor', targetSfIds: ['c1'] }] },
  ]);
  await writeJson(dataPath('transform', 'eras.json'),
    [{ key: 'donations:live', label: 'Donations', startYear: 2024, endYear: null }]);
}

describe('runLoad', () => {
  beforeEach(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-')));
    created = []; linked = []; createItemVariables = []; linkVariables = [];
    process.env['MONDAY_API_TOKEN'] = 'test-token';
    await seed();
  });

  it('creates items in dependency order then links', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // orgs before people before donations
    expect(linked.length).toBe(2);
  });

  it('sends create_labels_if_missing: true on both create_item and change_multiple_column_values', async () => {
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(createItemVariables.length).toBeGreaterThan(0);
    for (const v of createItemVariables) expect(v['create']).toBe(true);
    expect(linkVariables.length).toBeGreaterThan(0);
    for (const v of linkVariables) expect(v['create']).toBe(true);
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

  it('phase-2 link failures are ledgered distinctly, exit 1, and only the failed link retries', async () => {
    // Items are created in order Acme, Ada, Gift, so their ids are deterministically
    // 101/102/103 (id = 100 + created.length at the time of that create_item call). Failing
    // the change_multiple_column_values call for itemId '103' fails Gift's own Donor link
    // write without touching item creation for any of the three payloads.
    expect(await runLoad([], { client: fakeClient(new Set(), new Set(['103'])) })).toBe(1);
    expect(created.map((c) => c.name)).toEqual(['Acme', 'Ada', 'Gift']); // all items still created

    const l = new Ledger(); await l.load();
    expect(l.failures().map((f) => f.sfId)).toEqual(['o1']); // link failure, not an item-create failure
    expect(l.linkDone('c1', 'Organization')).toBe(true); // Ada's link succeeded
    expect(l.linkDone('o1', 'Donor')).toBe(false); // Gift's link did not

    created = []; linked = [];
    expect(await runLoad([], { client: fakeClient() })).toBe(0);
    expect(created).toEqual([]); // no items re-created
    expect(linked).toEqual(['103']); // only the previously-failed link retried
    const l2 = new Ledger(); await l2.load();
    expect(l2.failures()).toEqual([]);
    expect(l2.linkDone('o1', 'Donor')).toBe(true);
  });
});
