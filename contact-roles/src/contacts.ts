// Pure role matching: which Contacts an item should carry, given the Affiliations board.
// No I/O. Output is sorted and de-duplicated so reruns produce identical writes.
import type { BoardRule } from './config.ts';

export interface Affiliation { id: string; personId: string; orgId: string; status: string; roles: string[] }
export type AffiliationIndex = Map<string, Affiliation[]>; // orgId -> affiliations
export interface BoardItem { id: string; orgIds: string[]; typeLabel: string | null; currentPersonIds: string[] }
export interface ContactUpdate { itemId: string; personIds: string[] }

/** Index affiliations by organization, keeping only those whose status is the current label. */
export function buildIndex(affiliations: Affiliation[], currentLabel: string): AffiliationIndex {
  const index: AffiliationIndex = new Map();
  for (const a of affiliations) {
    if (a.status !== currentLabel) continue;
    const list = index.get(a.orgId);
    if (list) list.push(a);
    else index.set(a.orgId, [a]);
  }
  return index;
}

/** The role this item needs: the rule's fixed role, or typeRoles[Type]; null when none applies. */
export function roleFor(rule: BoardRule, item: BoardItem): string | null {
  if (rule.role !== undefined) return rule.role;
  if (item.typeLabel === null || rule.typeRoles === undefined) return null;
  return Object.hasOwn(rule.typeRoles, item.typeLabel) ? (rule.typeRoles[item.typeLabel] ?? null) : null;
}

/** Unique, sorted person ids holding the item's role at any of its organizations. */
export function contactsFor(rule: BoardRule, item: BoardItem, index: AffiliationIndex): string[] {
  const role = roleFor(rule, item);
  if (role === null) return [];
  const people = new Set<string>();
  for (const orgId of item.orgIds) {
    for (const a of index.get(orgId) ?? []) {
      if (a.roles.includes(role)) people.add(a.personId);
    }
  }
  return [...people].sort();
}

/** Updates for only those items whose current contacts differ from the desired set. */
export function planBoard(rule: BoardRule, items: BoardItem[], index: AffiliationIndex): ContactUpdate[] {
  const updates: ContactUpdate[] = [];
  for (const item of items) {
    const want = contactsFor(rule, item, index);
    const have = [...new Set(item.currentPersonIds)].sort();
    if (want.length !== have.length || want.some((id, i) => id !== have[i])) {
      updates.push({ itemId: item.id, personIds: want });
    }
  }
  return updates;
}
