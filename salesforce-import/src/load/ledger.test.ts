import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.js';

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
});
