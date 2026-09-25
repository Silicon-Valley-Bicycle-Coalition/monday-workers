import { describe, expect, it } from 'vitest';
import { parseSnapshot } from './snapshot';

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: 'monday-backup/2', runId: 3, errors: [], itemCountsByBoard: { '1': 1 }, blockCountsByDoc: { d1: 1 }, ...extra });

describe('parseSnapshot', () => {
  it('reads boards (items, updates) and docs (blocks) back from JSONL', () => {
    const snapshot = parseSnapshot(
      new Map([
        ['manifest.json', manifest()],
        [
          'board-1.jsonl',
          jsonl(
            { type: 'board', board: { id: '1', name: 'Donors', workspaceId: 'ws' }, schema: { columns: [], groups: [] } },
            { type: 'item', item: { id: 'i1', name: 'Ada', groupId: 'g', columnValues: [] } },
            { type: 'update', update: { id: 'u1', itemId: 'i1', body: 'hi', replies: [], assets: [] } },
          ),
        ],
        ['doc-d1.jsonl', jsonl({ type: 'doc', doc: { id: 'd1', name: 'Runbook' } }, { type: 'block', block: { id: 'b1', type: 'normal_text' } })],
        ['notes.txt', 'ignored'],
      ]),
    );
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.boards[0]!.items.map((i) => i.id)).toEqual(['i1']);
    expect(snapshot.boards[0]!.updates.map((u) => u.id)).toEqual(['u1']);
    expect(snapshot.docs[0]!.blocks.map((b) => b.id)).toEqual(['b1']);
    expect(snapshot.warnings).toEqual([]);
  });

  it('refuses a folder without a manifest (an unfinished run)', () => {
    expect(() => parseSnapshot(new Map([['board-1.jsonl', '']]))).toThrow(/no manifest/);
  });

  it('refuses an unknown snapshot format', () => {
    expect(() => parseSnapshot(new Map([['manifest.json', JSON.stringify({ format: 'monday-backup/1' })]]))).toThrow(/format/);
  });

  it('warns when the snapshot was partial or a file disagrees with the manifest', () => {
    const snapshot = parseSnapshot(
      new Map([
        ['manifest.json', manifest({ errors: ['board 9 (X): HTTP 500'], itemCountsByBoard: { '1': 5 } })],
        ['board-1.jsonl', jsonl({ type: 'board', board: { id: '1', name: 'B', workspaceId: null }, schema: { columns: [], groups: [] } })],
      ]),
    );
    expect(snapshot.warnings).toEqual(['snapshot was partial: board 9 (X): HTTP 500', 'board-1.jsonl: manifest says 5 items, file has 0']);
  });

  it('rejects malformed files with the file and line', () => {
    expect(() => parseSnapshot(new Map([['manifest.json', manifest()], ['board-1.jsonl', '{"type":"item","item":{}}\n']]))).toThrow(
      /board-1.jsonl: first record must be the board header/,
    );
    expect(() => parseSnapshot(new Map([['manifest.json', manifest()], ['doc-1.jsonl', 'nope\n']]))).toThrow(/doc-1.jsonl:1: not valid JSON/);
  });
});
