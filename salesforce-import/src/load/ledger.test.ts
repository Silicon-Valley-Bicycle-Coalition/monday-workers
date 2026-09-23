import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.js';
import { appendNdjson, dataPath } from '../artifacts.js';

describe('Ledger', () => {
  beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), 'sfimp-'))); });

  it('persists successes and resolves item ids', async () => {
    const a = new Ledger(); await a.load();
    await a.recordSuccess({ sfId: 'c1', board: 'people-live', itemId: '111' });
    const b = new Ledger(); await b.load();
    expect(b.has('c1', 'people-live')).toBe(true);
    expect(b.itemId('c1')).toBe('111');
  });

  it('a retry success clears an earlier failure', async () => {
    const a = new Ledger(); await a.load();
    await a.recordFailure({ sfId: 'o1', board: 'donations:live', error: 'HTTP 500' });
    await a.recordSuccess({ sfId: 'o1', board: 'donations:live', itemId: '222' });
    const b = new Ledger(); await b.load();
    expect(b.failures()).toEqual([]);
    expect(b.has('o1', 'donations:live')).toBe(true);
  });

  it('tracks link completion per column', async () => {
    const a = new Ledger(); await a.load();
    expect(a.linkDone('c1', 'Organization')).toBe(false);
    await a.recordLink('c1', 'Organization');
    const b = new Ledger(); await b.load();
    expect(b.linkDone('c1', 'Organization')).toBe(true);
  });

  it('tracks archives; a retry archive clears an earlier archive failure', async () => {
    const a = new Ledger(); await a.load();
    expect(a.archivedDone('o1')).toBe(false);
    await a.recordArchiveFailure('o1', 'HTTP 500');
    await a.recordArchive('o1');
    const b = new Ledger(); await b.load();
    expect(b.archivedDone('o1')).toBe(true);
    expect(b.failures()).toEqual([]);
  });

  it('a link failure carries its target sfIds; the retry success clears them', async () => {
    const a = new Ledger(); await a.load();
    await a.recordLinkFailure({ sfId: 'r1', column: 'Payment', error: 'boom', targetSfIds: ['o-old'] });
    const b = new Ledger(); await b.load();
    expect(b.failures()).toEqual([
      { sfId: 'r1', board: 'link:Payment', error: 'boom', targetSfIds: ['o-old'] }]);
    await b.recordLink('r1', 'Payment');
    const c = new Ledger(); await c.load();
    expect(c.failures()).toEqual([]);
  });

  it('parses pre-targetSfIds linkFailure entries (older ledger.ndjson format)', async () => {
    await appendNdjson(dataPath('load', 'ledger.ndjson'),
      { kind: 'linkFailure', sfId: 'r1', column: 'Payment', error: 'boom' });
    const a = new Ledger(); await a.load();
    expect(a.failures().map((f) => ({ sfId: f.sfId, board: f.board, targets: f.targetSfIds ?? [] })))
      .toEqual([{ sfId: 'r1', board: 'link:Payment', targets: [] }]);
  });

  it('an archive failure is keyed apart from create and link failures', async () => {
    const a = new Ledger(); await a.load();
    await a.recordSuccess({ sfId: 'o1', board: 'donations', itemId: '9' });
    await a.recordArchiveFailure('o1', 'boom');
    const b = new Ledger(); await b.load();
    expect(b.has('o1', 'donations')).toBe(true); // success untouched
    expect(b.failures().map((f) => f.board)).toEqual(['archive']);
  });

  it('survives a torn final line from a crash mid-append', async () => {
    const a = new Ledger(); await a.load();
    await a.recordSuccess({ sfId: 'c1', board: 'people-live', itemId: '111' });
    appendFileSync(dataPath('load', 'ledger.ndjson'), '{"kind":"success","sfId":"c2","bo');
    const b = new Ledger(); await b.load();
    expect(b.itemId('c1')).toBe('111');
    expect(b.itemId('c2')).toBeUndefined();
    await b.recordSuccess({ sfId: 'c3', board: 'people-live', itemId: '333' });
    const c = new Ledger(); await c.load();
    expect(c.itemId('c3')).toBe('333');
  });

  it('linkCovers is false once more targets resolve than the earlier write set', async () => {
    const a = new Ledger(); await a.load();
    expect(a.linkCovers('o1', 'Donor', ['c1'])).toBe(false);
    await a.recordLink('o1', 'Donor', ['c1']);
    const b = new Ledger(); await b.load();
    expect(b.linkCovers('o1', 'Donor', ['c1'])).toBe(true);
    expect(b.linkCovers('o1', 'Donor', ['c1', 'c2'])).toBe(false);
  });

  it('treats a pre-targetSfIds link entry as covering (older ledger.ndjson format)', async () => {
    await appendNdjson(dataPath('load', 'ledger.ndjson'), { kind: 'link', sfId: 'o1', column: 'Donor' });
    const a = new Ledger(); await a.load();
    expect(a.linkCovers('o1', 'Donor', ['c1', 'c2'])).toBe(true);
  });

  it('hasAnyFor reports whether any item has ever landed successfully on a board', async () => {
    const a = new Ledger(); await a.load();
    expect(a.hasAnyFor('people-live')).toBe(false);
    await a.recordSuccess({ sfId: 'c1', board: 'people-live', itemId: '111' });
    const b = new Ledger(); await b.load();
    expect(b.hasAnyFor('people-live')).toBe(true);
    expect(b.hasAnyFor('organizations')).toBe(false);
  });
});
