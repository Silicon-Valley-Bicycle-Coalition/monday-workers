import type { ItemPayload } from './types.js';
import { consentLabel, dateCol, salesforceDebug } from './fields.js';

export interface AffiliationContext {
  personName: string; orgName: string; workEmail: string | null; consent: ReadonlyMap<string, string>;
}
export interface Tenure { sfId: string; startISO: string | null; endISO: string | null; primary: boolean }

// NPSP's picklist is Current / Former with Current as the default, so a blank is Current.
export function affiliationStatus(raw: unknown): 'Current' | 'Former' {
  return raw === 'Former' ? 'Former' : 'Current';
}

const emailCol = (e: string | null) => (e ? { email: e, text: e } : null);

export function affiliationToPayload(a: Record<string, unknown>, ctx: AffiliationContext): ItemPayload {
  const columns: Record<string, unknown> = {
    // 'Affiliation Role', not 'Role': column titles are global in load/boards.ts, and Event
    // Registrations already use 'Role' as a Participant / Volunteer status column.
    'Affiliation Role': (a['npe5__Role__c'] ?? '') as string,
    'Status': { label: affiliationStatus(a['npe5__Status__c']) },
    'Start': dateCol(a['npe5__StartDate__c'] as string | null),
    'End': dateCol(a['npe5__EndDate__c'] as string | null),
    'Primary': a['npe5__Primary__c'] === true ? { checked: 'true' } : null,
    'Work Email': emailCol(ctx.workEmail),
    ...salesforceDebug(a),
  };
  if (ctx.workEmail) columns['Work Email Consent'] = { label: consentLabel(ctx.workEmail, ctx.consent) };
  return {
    board: 'affiliations', sfId: a['Id'] as string,
    name: `${ctx.personName} @ ${ctx.orgName}`,
    columns,
    links: [
      { column: 'Person', targetSfIds: [a['npe5__Contact__c'] as string] },
      { column: 'Organization', targetSfIds: [a['npe5__Organization__c'] as string] },
    ],
  };
}

// Which of a person's tenures at ONE organization an event on `onISO` belongs to: the one
// whose dates bracket it (an open end brackets everything after its start; no dates at all
// brackets everything), else the Primary-flagged one, else the first.
export function pickAffiliation<T extends Tenure>(candidates: readonly T[], onISO: string | null): T | null {
  if (candidates.length === 0) return null;
  const day = onISO?.slice(0, 10) ?? null;
  if (day) {
    const bracketing = candidates.find((t) =>
      (t.startISO === null || t.startISO.slice(0, 10) <= day) &&
      (t.endISO === null || day <= t.endISO.slice(0, 10)));
    if (bracketing) return bracketing;
  }
  return candidates.find((t) => t.primary) ?? candidates[0] ?? null;
}
