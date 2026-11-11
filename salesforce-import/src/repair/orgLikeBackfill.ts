// Backfills a board set that was loaded BEFORE `organizationAccountSfIds` existed: the Organizations
// items for org-like One-to-One Accounts and the Affiliations items that point at them, which the
// transform used to drop (their roles never reached Monday). Pure planning only — the Monday I/O
// is in scripts/backfill-org-like-accounts.ts, which runs it once per environment.
import type { ItemPayload } from '../transform/types.js';

export type PeopleBoard = 'people-live' | 'people-historical';
export interface PersonRef { id: string; board: PeopleBoard }

export interface BackfillInput {
  /** config `organizationAccountSfIds` */
  orgSfIds: ReadonlySet<string>;
  /** the transform's payloads.ndjson, run with that config */
  payloads: readonly ItemPayload[];
  /** sfId → item ids already on the Organizations board (several = a duplicate) */
  existingOrgs: ReadonlyMap<string, readonly string[]>;
  /** sfId → item ids already on the Affiliations board */
  existingAffiliations: ReadonlyMap<string, readonly string[]>;
  /** Person sfId → where that Person lives (an affiliation can only link to a Person that was loaded) */
  people: ReadonlyMap<string, PersonRef>;
}

export interface PlannedOrg { payload: ItemPayload; existingItemId?: string }
export interface PlannedAffiliation {
  payload: ItemPayload; orgSfId: string; personSfId: string; person: PersonRef;
  /** the Person's Organization column only ever lists CURRENT tenures (transform/index.ts) */
  current: boolean; existingItemId?: string;
}
export interface BackfillPlan {
  orgs: PlannedOrg[];
  affiliations: PlannedAffiliation[];
  skipped: { sfId: string; reason: string }[];
  duplicates: { board: 'organizations' | 'affiliations'; sfId: string; itemIds: string[] }[];
}

const linkTarget = (p: ItemPayload, column: string): string | undefined =>
  p.links?.find((l) => l.column === column)?.targetSfIds[0];

export function planBackfill(input: BackfillInput): BackfillPlan {
  const plan: BackfillPlan = { orgs: [], affiliations: [], skipped: [], duplicates: [] };
  const first = (m: ReadonlyMap<string, readonly string[]>, board: 'organizations' | 'affiliations', sfId: string) => {
    const ids = m.get(sfId) ?? [];
    if (ids.length > 1) plan.duplicates.push({ board, sfId, itemIds: [...ids] });
    return ids[0];
  };

  const seenOrgs = new Set<string>();
  for (const p of input.payloads) {
    if (p.board !== 'organizations' || !input.orgSfIds.has(p.sfId)) continue;
    seenOrgs.add(p.sfId);
    const existingItemId = first(input.existingOrgs, 'organizations', p.sfId);
    plan.orgs.push(existingItemId ? { payload: p, existingItemId } : { payload: p });
  }
  for (const sfId of input.orgSfIds) {
    if (!seenOrgs.has(sfId)) plan.skipped.push({ sfId, reason: 'configured organization account has no Organizations payload — re-run the transform with the current config' });
  }

  for (const p of input.payloads) {
    if (p.board !== 'affiliations') continue;
    const orgSfId = linkTarget(p, 'Organization');
    if (!orgSfId || !input.orgSfIds.has(orgSfId)) continue;
    const personSfId = linkTarget(p, 'Person');
    const person = personSfId ? input.people.get(personSfId) : undefined;
    if (!personSfId || !person) {
      plan.skipped.push({ sfId: p.sfId, reason: `Person ${personSfId ?? '(none)'} is not on a People board` });
      continue;
    }
    const status = (p.columns['Status'] as { label?: string } | undefined)?.label;
    const existingItemId = first(input.existingAffiliations, 'affiliations', p.sfId);
    plan.affiliations.push({ payload: p, orgSfId, personSfId, person, current: status === 'Current',
      ...(existingItemId ? { existingItemId } : {}) });
  }
  return plan;
}

/** Ids to write to a connect column so it keeps what it has and gains `add`; null when nothing is new. */
export function mergeLinkedIds(current: readonly string[], add: readonly string[]): string[] | null {
  const have = new Set(current);
  const fresh = [...new Set(add)].filter((id) => !have.has(id));
  return fresh.length === 0 ? null : [...current, ...fresh];
}
