import { describe, expect, it } from 'vitest';
import type { BoardRule } from './config';
import { buildIndex, contactsFor, planBoard, roleFor } from './contacts';
import type { Affiliation, BoardItem } from './contacts';

const aff = (id: string, personId: string, orgId: string, status: string, roles: string[]): Affiliation => ({ id, personId, orgId, status, roles });

const grants: BoardRule = { name: 'Grants', boardId: 'b1', orgColumn: 'Organization', contactsColumn: 'Contacts', role: 'Grants', enabled: true };
const leads: BoardRule = {
  name: 'Leads', boardId: 'b2', orgColumn: 'Organization', contactsColumn: 'Contacts', typeColumn: 'Type',
  typeRoles: { Grant: 'Grants' }, enabled: true,
};
const item = (over: Partial<BoardItem> = {}): BoardItem => ({ id: 'i1', orgIds: ['o1'], typeLabel: null, currentPersonIds: [], ...over });

const all = [
  aff('a1', 'p1', 'o1', 'Current', ['Grants']),
  aff('a2', 'p2', 'o1', 'Former', ['Grants']),
  aff('a3', 'p3', 'o1', 'Draft', ['Grants']),
  aff('a4', 'p4', 'o1', 'Current', ['Billing']),
];

describe('contacts', () => {
  it('buildIndex drops Former and Draft affiliations', () => {
    const idx = buildIndex(all, 'Current');
    expect(idx.get('o1')?.map((a) => a.id)).toEqual(['a1', 'a4']);
  });

  it('contactsFor returns only people holding the board role at the org', () => {
    expect(contactsFor(grants, item(), buildIndex(all, 'Current'))).toEqual(['p1']);
  });

  it('a person with two roles at one org appears once', () => {
    const idx = buildIndex([aff('a1', 'p1', 'o1', 'Current', ['Grants', 'Billing']), aff('a2', 'p1', 'o1', 'Current', ['Grants'])], 'Current');
    expect(contactsFor(grants, item(), idx)).toEqual(['p1']);
  });

  it('is sorted and stable across input order', () => {
    const a = [aff('a1', 'p9', 'o1', 'Current', ['Grants']), aff('a2', 'p2', 'o1', 'Current', ['Grants'])];
    const r1 = contactsFor(grants, item(), buildIndex(a, 'Current'));
    const r2 = contactsFor(grants, item(), buildIndex([...a].reverse(), 'Current'));
    expect(r1).toEqual(['p2', 'p9']);
    expect(r2).toEqual(r1);
  });

  it('empty orgIds gives []', () => {
    expect(contactsFor(grants, item({ orgIds: [] }), buildIndex(all, 'Current'))).toEqual([]);
  });

  it('Leads rule maps Type to a role; unmapped or missing Type gives []', () => {
    const idx = buildIndex(all, 'Current');
    expect(roleFor(leads, item({ typeLabel: 'Grant' }))).toBe('Grants');
    expect(contactsFor(leads, item({ typeLabel: 'Grant' }), idx)).toEqual(['p1']);
    expect(contactsFor(leads, item({ typeLabel: 'Contract' }), idx)).toEqual([]);
    expect(contactsFor(leads, item({ typeLabel: null }), idx)).toEqual([]);
  });

  it('planBoard skips items already correct in any order', () => {
    const a = [aff('a1', 'p1', 'o1', 'Current', ['Grants']), aff('a2', 'p2', 'o1', 'Current', ['Grants'])];
    const idx = buildIndex(a, 'Current');
    expect(planBoard(grants, [item({ currentPersonIds: ['p2', 'p1'] })], idx)).toEqual([]);
    expect(planBoard(grants, [item({ currentPersonIds: ['p1'] })], idx)).toEqual([{ itemId: 'i1', personIds: ['p1', 'p2'] }]);
  });

  it('an item at two organizations unions both orgs contacts', () => {
    const a = [aff('a1', 'p1', 'o1', 'Current', ['Grants']), aff('a2', 'p2', 'o2', 'Current', ['Grants']), aff('a3', 'p1', 'o2', 'Current', ['Grants'])];
    expect(contactsFor(grants, item({ orgIds: ['o1', 'o2'] }), buildIndex(a, 'Current'))).toEqual(['p1', 'p2']);
  });
});
