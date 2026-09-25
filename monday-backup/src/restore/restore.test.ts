import { describe, expect, it } from 'vitest';
import { AmbiguousWriteError } from '../monday/graphql';
import type { ColumnValue, ItemRecord, UpdateRecord } from '../types';
import { DryRunRestoreApi } from './api';
import { RestoreLedger } from './ledger';
import { restoreSnapshot, type RestoreOptions } from './restore';
import type { BoardSnapshot, DocSnapshot, Snapshot } from './snapshot';

// ── Fixture: a Donors board, a Donations board connected to it, subitems, updates, a Doc ──────

const cv = (id: string, text: string | null, value: unknown = null, extra: Partial<ColumnValue> = {}): ColumnValue => ({
  id,
  text,
  value: value === null ? null : JSON.stringify(value),
  ...extra,
});

const item = (id: string, name: string, extra: Partial<ItemRecord> = {}): ItemRecord => ({
  id,
  name,
  groupId: 'topics',
  columnValues: [],
  ...extra,
});

const update = (id: string, itemId: string | null, createdAt: string, extra: Partial<UpdateRecord> = {}): UpdateRecord => ({
  id,
  itemId,
  body: `<p>${id}</p>`,
  textBody: id,
  createdAt,
  updatedAt: createdAt,
  creatorId: '77',
  replies: [],
  assets: [],
  ...extra,
});

function donors(): BoardSnapshot {
  return {
    board: { id: '10', name: 'Donors', workspaceId: 'src-ws', state: 'active', type: 'board', boardKind: 'private', description: 'People who give' },
    schema: {
      columns: [
        { id: 'name', title: 'Name', type: 'name', settingsStr: '{}' },
        { id: 'email', title: 'Email', type: 'email', settingsStr: '{}' },
        { id: 'status', title: 'Stage', type: 'status', settingsStr: '{"labels":{"1":"Active"}}' },
        { id: 'subitems', title: 'Subitems', type: 'subtasks', settingsStr: '{"boardIds":[12]}' },
      ],
      groups: [
        { id: 'topics', title: 'Current' },
        { id: 'lapsed', title: 'Lapsed' },
      ],
    },
    items: [
      item('100', 'Ada', {
        columnValues: [cv('email', 'ada@example.org', { email: 'ada@example.org', text: 'Ada' }), cv('status', 'Active', { index: 1 })],
        assets: [{ id: 'a1', name: 'pledge.pdf', fileExtension: '.pdf', fileSize: 10, createdAt: null, url: null, uploadedById: null }],
      }),
      item('101', 'Grace', { groupId: 'lapsed' }),
    ],
    updates: [
      update('u2', '100', '2026-02-01T00:00:00Z', {
        replies: [{ id: 'r1', body: '<p>reply</p>', textBody: 'reply', createdAt: '2026-02-02T00:00:00Z', updatedAt: null, creatorId: '78' }],
      }),
      update('u1', '100', '2026-01-01T00:00:00Z'),
      update('u3', null, '2026-03-01T00:00:00Z'),
    ],
  };
}

function donations(): BoardSnapshot {
  return {
    board: { id: '11', name: 'Donations', workspaceId: 'src-ws', state: 'archived', type: 'board', boardKind: 'public' },
    schema: {
      columns: [
        { id: 'amount', title: 'Amount', type: 'numbers', settingsStr: '{}' },
        { id: 'donor_link_mkq1', title: 'Donor', type: 'board_relation', settingsStr: '{"boardIds":[10]}' },
        { id: 'donor_email', title: 'Donor email', type: 'mirror', settingsStr: '{}' },
      ],
      groups: [{ id: 'topics', title: 'Gifts' }],
    },
    items: [
      item('200', 'Gift 1', {
        columnValues: [cv('amount', '50', '"50"'), cv('donor_link_mkq1', null, null, { linkedItemIds: ['100', '999'] })],
      }),
    ],
    updates: [],
  };
}

function subitems(): BoardSnapshot {
  return {
    board: { id: '12', name: 'Subitems of Donors', workspaceId: 'src-ws', type: 'sub_items_board' },
    schema: {
      columns: [
        { id: 'name', title: 'Name', type: 'name', settingsStr: '{}' },
        { id: 'person', title: 'Owner', type: 'people', settingsStr: '{}' },
        { id: 'notes', title: 'Notes', type: 'text', settingsStr: '{}' },
      ],
      groups: [],
    },
    items: [
      item('300', 'Thank-you call', { parentItemId: '100', columnValues: [cv('notes', 'called', '"called"')] }),
      item('301', 'Orphan', { parentItemId: '404' }),
    ],
    updates: [],
  };
}

function runbook(): DocSnapshot {
  return {
    doc: { id: 'd1', name: 'Runbook', workspaceId: 'src-ws', url: null, docKind: 'private' },
    blocks: [
      { id: 'b1', type: 'large_title', content: '{"deltaFormat":[{"insert":"Title"}]}', parentBlockId: null },
      { id: 'b2', type: 'bulleted_list', content: { deltaFormat: [{ insert: 'one' }] }, parentBlockId: null },
      { id: 'b3', type: 'normal_text', content: '{"deltaFormat":[{"insert":"nested"}]}', parentBlockId: 'b2' },
      { id: 'b4', type: 'normal_text', content: '{"deltaFormat":[{"insert":"end"}]}', parentBlockId: null },
    ],
  };
}

function snapshot(): Snapshot {
  return { manifest: { format: 'monday-backup/2' }, boards: [donors(), donations(), subitems()], docs: [runbook()], warnings: [] };
}

function run(api: DryRunRestoreApi, extra: Partial<RestoreOptions> = {}, snap: Snapshot = snapshot(), ledger = new RestoreLedger()) {
  return restoreSnapshot(snap, { api, ledger, targetWorkspaceId: 'target-ws', nameSuffix: ' (restored)', ...extra });
}

describe('restoreSnapshot', () => {
  it('recreates boards in the target workspace with suffixed names, kind and description', async () => {
    const api = new DryRunRestoreApi();
    const report = await run(api);
    expect(api.argsOf('createBoard')).toEqual([
      { name: 'Donors (restored)', kind: 'private', workspaceId: 'target-ws', description: 'People who give' },
      { name: 'Donations (restored)', kind: 'public', workspaceId: 'target-ws', description: null },
    ]);
    expect(report.boards).toBe(2);
  });

  it('recreates groups in their original order and columns with reusable ids and label settings', async () => {
    const api = new DryRunRestoreApi();
    await run(api);
    // create_group inserts at the top, so they are created last-first.
    expect(api.argsOf('createGroup').filter((g) => g.boardId === '1000').map((g) => g.name)).toEqual(['Lapsed', 'Current']);

    const donorColumns = api.argsOf('createColumn').filter((c) => c.boardId === '1000');
    expect(donorColumns).toEqual([
      { boardId: '1000', title: 'Email', type: 'email', description: null, defaults: undefined, id: 'email' },
      { boardId: '1000', title: 'Stage', type: 'status', description: null, defaults: { labels: { '1': 'Active' } }, id: 'status' },
    ]);
    // `donor_link_mkq1` has digits, which Monday won't accept as a custom id — a new id is issued.
    const relation = api.argsOf('createColumn').find((c) => c.type === 'board_relation')!;
    expect(relation.id).toBeUndefined();
    expect(relation.defaults).toEqual({ boardIds: [1000] }); // remapped to the restored Donors board
  });

  it('creates items with converted values in their mapped groups', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    const ada = api.argsOf('createItem').find((i) => i.name === 'Ada')!;
    expect(ada.boardId).toBe(ledger.get('board', '10'));
    expect(ada.groupId).toBe(ledger.get('group', '10:topics'));
    expect(ada.columnValues).toEqual({ email: { email: 'ada@example.org', text: 'Ada' }, status: { label: 'Active' } });
    const grace = api.argsOf('createItem').find((i) => i.name === 'Grace')!;
    expect(grace.groupId).toBe(ledger.get('group', '10:lapsed'));
    expect(report.items).toBe(3);
  });

  it('creates subitems under their restored parents, adds the subitems board columns, and sets values', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    const subs = api.argsOf('createSubitem');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.parentItemId).toBe(ledger.get('item', '100'));
    expect(subs[0]!.name).toBe('Thank-you call');
    // "Owner" (people) matches the auto-created default and is reused; "Notes" is created.
    const subColumns = api.argsOf('createColumn').filter((c) => c.title === 'Notes' || c.title === 'Owner');
    expect(subColumns.map((c) => c.title)).toEqual(['Notes']);
    const subValues = api.argsOf('setColumnValues').find((s) => 'notes' in s.columnValues)!;
    expect(subValues.columnValues).toEqual({ notes: 'called' });
    expect(report.subitems).toBe(1);
    expect(report.warnings.some((w) => /subitem 301 .*parent item 404 was not restored/.test(w))).toBe(true);
  });

  it('writes connect-boards values in a second pass with restored ids, reporting links it cannot map', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    const relationColumnId = ledger.get('column', '11:donor_link_mkq1')!;
    const write = api.argsOf('setColumnValues').find((s) => relationColumnId in s.columnValues)!;
    expect(write.itemId).toBe(ledger.get('item', '200'));
    expect(write.columnValues[relationColumnId]).toEqual({ item_ids: [Number(ledger.get('item', '100'))] });
    expect(report.relations).toBe(1);
    expect(report.warnings.some((w) => /links to 999 dropped/.test(w))).toBe(true);
    // Mirror columns are created but never written, and flagged for a settings check.
    expect(report.warnings.some((w) => /"Donor email" \(mirror\) is computed/.test(w))).toBe(true);
  });

  it('replays updates oldest first with provenance, then replies; skips board-level updates with a warning', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    const updates = api.argsOf('createUpdate');
    expect(updates.map((u) => u.body.replace(/<p><em>.*?<\/em><\/p>/, ''))).toEqual(['<p>u1</p>', '<p>u2</p>', '<p>reply</p>']);
    expect(updates[0]!.body).toContain('originally posted by user 77 at 2026-01-01T00:00:00Z');
    expect(updates[2]!.parentId).toBe(ledger.get('update', 'u2'));
    expect(report.updates).toBe(3);
    expect(report.warnings.some((w) => /1 board-level update/.test(w))).toBe(true);
    expect(report.warnings.some((w) => /1 item file\(s\) not restored/.test(w))).toBe(true);
  });

  it('archives boards that were archived, after restoring their contents', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    await run(api, {}, snapshot(), ledger);
    const donationsBoard = ledger.get('board', '11')!;
    const archives = api.calls.filter((c) => c.method === 'archiveBoard');
    expect(archives.map((c) => c.args)).toEqual([donationsBoard]); // Donors was active: not archived
    const archiveAt = api.calls.findIndex((c) => c.method === 'archiveBoard');
    const lastWriteToDonations = api.calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => (c.args as { boardId?: string } | null)?.boardId === donationsBoard)
      .pop()![1];
    expect(archiveAt).toBeGreaterThan(lastWriteToDonations);
  });

  it('recreates Docs block by block, keeping order and nesting', async () => {
    const api = new DryRunRestoreApi();
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    expect(api.argsOf('createDoc')).toEqual([{ workspaceId: 'target-ws', name: 'Runbook (restored)', kind: 'private' }]);
    const blocks = api.argsOf('createDocBlock');
    expect(blocks.map((b) => b.type)).toEqual(['large_title', 'bulleted_list', 'normal_text', 'normal_text']);
    expect(blocks[1]!.afterBlockId).toBe(ledger.get('block', 'b1'));
    expect(blocks[1]!.content).toBe('{"deltaFormat":[{"insert":"one"}]}'); // object content re-encoded
    expect(blocks[2]!.parentBlockId).toBe(ledger.get('block', 'b2'));
    expect(blocks[2]!.afterBlockId).toBeUndefined(); // first child
    expect(blocks[3]!.afterBlockId).toBe(ledger.get('block', 'b2')); // after its top-level sibling
    expect(report.blocks).toBe(4);
  });

  it('resumes from the ledger without creating anything twice', async () => {
    const lines: string[] = [];
    const first = new DryRunRestoreApi();
    await run(first, {}, snapshot(), new RestoreLedger((l) => lines.push(l)));

    const second = new DryRunRestoreApi();
    await run(second, {}, snapshot(), RestoreLedger.fromJsonl(lines.join('')));
    const creates = second.calls.filter((c) => c.method.startsWith('create') || c.method === 'setColumnValues' || c.method === 'archiveBoard');
    expect(creates).toEqual([]);
  });

  it('falls back to a plain column when Monday rejects the original id or settings', async () => {
    const api = new DryRunRestoreApi((method, args) =>
      method === 'createColumn' && (args as { defaults?: unknown }).defaults !== undefined ? new Error('invalid defaults') : undefined,
    );
    const ledger = new RestoreLedger();
    const report = await run(api, {}, snapshot(), ledger);
    expect(ledger.get('column', '10:status')).toBeDefined();
    expect(report.warnings.some((w) => /"Stage" \(status\) created without its original id\/settings \(invalid defaults\)/.test(w))).toBe(true);
    expect(api.argsOf('createColumn').filter((c) => c.title === 'Stage')).toHaveLength(2);
  });

  it('keeps an item whose values Monday rejects, then sets its values one at a time', async () => {
    let rejected = false;
    const api = new DryRunRestoreApi((method, args) => {
      if (method === 'createItem' && (args as { name: string }).name === 'Ada' && !rejected) {
        rejected = true;
        return new Error('invalid value for column status');
      }
      return undefined;
    });
    const report = await run(api);
    expect(api.argsOf('createItem').filter((i) => i.name === 'Ada').map((i) => i.columnValues)).toEqual([
      { email: { email: 'ada@example.org', text: 'Ada' }, status: { label: 'Active' } },
      {},
    ]);
    expect(api.argsOf('setColumnValues').filter((s) => 'email' in s.columnValues || 'status' in s.columnValues)).toHaveLength(2);
    expect(report.warnings.some((w) => /item 100 "Ada": values rejected/.test(w))).toBe(true);
  });

  it('stops on an ambiguous write rather than guessing', async () => {
    const api = new DryRunRestoreApi((method) => (method === 'createItem' ? new AmbiguousWriteError('HTTP 502') : undefined));
    await expect(run(api)).rejects.toBeInstanceOf(AmbiguousWriteError);
  });

  it('restores only the selected boards (with their subitems) and docs', async () => {
    const api = new DryRunRestoreApi();
    await run(api, { boardIds: ['10'], docIds: [] });
    expect(api.argsOf('createBoard').map((b) => b.name)).toEqual(['Donors (restored)']);
    expect(api.count('createSubitem')).toBe(1);
    expect(api.count('createDoc')).toBe(0);
  });
});
