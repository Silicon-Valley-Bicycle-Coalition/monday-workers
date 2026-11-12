import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardRule, ContactRolesConfig } from './config';
import type { Affiliation, BoardItem } from './contacts';
import type { ContactRolesMondayClient } from './monday/client';
import { ColumnLookupError } from './monday/client';
import { MondayApiError } from './monday/graphql';
import { runReconcile } from './reconcile';

const aff = (id: string, personId: string, orgId: string, status: string, roles: string[]): Affiliation => ({ id, personId, orgId, status, roles });
const rule = (over: Partial<BoardRule> = {}): BoardRule => ({ name: 'Grants', boardId: 'b1', orgColumn: 'Org', contactsColumn: 'Contacts', role: 'Grants', enabled: true, ...over });
const item = (id: string, orgIds: string[], currentPersonIds: string[] = []): BoardItem => ({ id, orgIds, typeLabel: null, currentPersonIds });

const config = (boards: BoardRule[]): ContactRolesConfig => ({
  monday: { apiUrl: 'x' },
  affiliations: { boardId: 'a', rolesColumn: 'SVBC Roles', statusColumn: 'Status', personColumn: 'Person', orgColumn: 'Organization', currentLabel: 'Current' },
  boards,
});

class MemClient implements ContactRolesMondayClient {
  writes: { boardId: string; itemId: string; personIds: string[] }[] = [];
  failBoards = new Set<string>();
  failWrites = new Set<string>();
  constructor(public labels: string[], public affs: Affiliation[], public items: Record<string, BoardItem[]>) {}
  async roleLabels() { return this.labels; }
  async listAffiliations() { return this.affs; }
  async listBoardItems(r: BoardRule) {
    if (this.failBoards.has(r.boardId)) throw new ColumnLookupError('board: no column');
    return (this.items[r.boardId] ?? []).map((i) => ({ ...i }));
  }
  async setContacts(r: BoardRule, itemId: string, personIds: string[]) {
    if (this.failWrites.has(itemId)) throw new Error('boom');
    this.writes.push({ boardId: r.boardId, itemId, personIds });
    const it = this.items[r.boardId]!.find((i) => i.id === itemId)!;
    it.currentPersonIds = personIds;
  }
}

const affs = [
  aff('a1', 'p1', 'o1', 'Current', ['Grants']),
  aff('a2', 'p2', 'o1', 'Former', ['Grants']),
  aff('a3', 'p3', 'o2', 'Current', ['Grants']),
];

afterEach(() => vi.restoreAllMocks());

describe('runReconcile', () => {
  it('on: writes each planned update once; a second run writes nothing', async () => {
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1']), item('i2', ['o2'])] });
    const s1 = await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(s1.boards[0]).toMatchObject({ items: 2, updates: 2, written: 2 });
    expect(m.writes).toEqual([
      { boardId: 'b1', itemId: 'i1', personIds: ['p1'] },
      { boardId: 'b1', itemId: 'i2', personIds: ['p3'] },
    ]);
    const s2 = await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(s2.boards[0]).toMatchObject({ updates: 0, written: 0 });
    expect(m.writes).toHaveLength(2);
  });

  it('off: writes nothing but reports the updates', async () => {
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])] });
    const s = await runReconcile({ monday: m, config: config([rule()]) }, 'off');
    expect(s.mode).toBe('off');
    expect(s.boards[0]).toMatchObject({ updates: 1, written: 0 });
    expect(m.writes).toEqual([]);
  });

  it('skips a board whose role is not a dropdown label, loudly, leaving Contacts alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new MemClient(['Billing'], affs, { b1: [item('i1', ['o1'], ['p9'])] });
    const read = vi.spyOn(m, 'listBoardItems');
    const s = await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(s.boards[0]).toMatchObject({ skipped: 'unknown-role', updates: 0, written: 0 });
    expect(m.writes).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('skips when any typeRoles role is unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = rule({ role: undefined, typeColumn: 'Type', typeRoles: { A: 'Grants', B: 'Nope' } });
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])] });
    const s = await runReconcile({ monday: m, config: config([r]) }, 'on');
    expect(s.boards[0]?.skipped).toBe('unknown-role');
  });

  it('a disabled board is skipped and never read', async () => {
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])] });
    const s = await runReconcile({ monday: m, config: config([rule({ enabled: false })]) }, 'on');
    expect(s.boards[0]).toMatchObject({ skipped: 'disabled', items: 0 });
    expect(m.writes).toEqual([]);
  });

  it('never writes a Former affiliation or a person without the role', async () => {
    const m = new MemClient(['Grants'], [aff('a1', 'p1', 'o1', 'Former', ['Grants']), aff('a2', 'p2', 'o1', 'Current', [])], { b1: [item('i1', ['o1'])] });
    const s = await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(s.boards[0]?.updates).toBe(0);
    expect(m.writes).toEqual([]);
  });

  it('clears Contacts when nobody holds the role any more', async () => {
    const m = new MemClient(['Grants'], [aff('a2', 'p2', 'o1', 'Former', ['Grants'])], { b1: [item('i1', ['o1'], ['p2'])] });
    await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(m.writes).toEqual([{ boardId: 'b1', itemId: 'i1', personIds: [] }]);
  });

  it('one board failing does not stop the others', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])], b2: [item('j1', ['o1'])] });
    m.failBoards.add('b1');
    const s = await runReconcile({ monday: m, config: config([rule(), rule({ name: 'Other', boardId: 'b2' })]) }, 'on');
    expect(s.boards[0]).toMatchObject({ failed: true, written: 0 });
    expect(s.boards[1]).toMatchObject({ written: 1 });
    expect(m.writes).toEqual([{ boardId: 'b2', itemId: 'j1', personIds: ['p1'] }]);
    expect(err).toHaveBeenCalled();
  });

  it('a write error on one board stops that board but not the next', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1']), item('i2', ['o2'])], b2: [item('j1', ['o1'])] });
    m.failWrites.add('i1');
    const s = await runReconcile({ monday: m, config: config([rule(), rule({ name: 'Other', boardId: 'b2' })]) }, 'on');
    expect(s.boards[0]).toMatchObject({ failed: true, written: 0 });
    expect(s.boards[1]?.written).toBe(1);
    const logged = JSON.parse(String(err.mock.calls[0]?.[0]));
    expect(logged).toEqual({ worker: 'contact-roles', event: 'board-failed', board: 'Grants', boardId: 'b1', error: 'Error', itemId: 'i1', written: 0 });
  });

  it('logs httpStatus and code for a MondayApiError on a board', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])] });
    m.listBoardItems = async () => { throw new MondayApiError('secret@example.com', { httpStatus: 429, code: 'RATE' }); };
    await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    const logged = JSON.parse(String(err.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({ error: 'MondayApiError', httpStatus: 429, code: 'RATE' });
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('a failing shared read logs run-failed (class name only), writes nothing and rethrows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new MemClient(['Grants'], affs, { b1: [item('i1', ['o1'])] });
    m.roleLabels = async () => { throw new TypeError('leaks a@b.co'); };
    await expect(runReconcile({ monday: m, config: config([rule()]), environment: 'sandbox' }, 'on')).rejects.toThrow(TypeError);
    expect(m.writes).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({ worker: 'contact-roles', event: 'run-failed', environment: 'sandbox', mode: 'on', error: 'TypeError' });
  });

  it('a dropdown label no board uses changes nothing', async () => {
    const m = new MemClient(['Grants', 'Brand New Role'], affs, { b1: [item('i1', ['o1'], ['p1'])] });
    const s = await runReconcile({ monday: m, config: config([rule()]) }, 'on');
    expect(s.boards[0]).toMatchObject({ updates: 0, written: 0 });
    expect(m.writes).toEqual([]);
  });
});
