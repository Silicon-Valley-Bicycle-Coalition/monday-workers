import { pickAffiliation, type Tenure } from './affiliations.js';

export interface AffiliationEntry extends Tenure { contactSfId: string; orgSfId: string; workEmail: string | null }

export class AffiliationIndex {
  private readonly contactOrg = new Map<string, AffiliationEntry[]>();
  private readonly email = new Map<string, AffiliationEntry>();
  private readonly contact = new Map<string, AffiliationEntry[]>();
  private readonly id = new Map<string, AffiliationEntry>();
  constructor(entries: readonly AffiliationEntry[]) {
    for (const e of entries) {
      this.id.set(e.sfId, e);
      const key = `${e.contactSfId}|${e.orgSfId}`;
      (this.contactOrg.get(key) ?? this.contactOrg.set(key, []).get(key)!).push(e);
      (this.contact.get(e.contactSfId) ?? this.contact.set(e.contactSfId, []).get(e.contactSfId)!).push(e);
      // First-seen wins when two tenures share a work email address.
      const emailKey = e.workEmail?.trim().toLowerCase();
      if (emailKey && !this.email.has(emailKey)) this.email.set(emailKey, e);
    }
  }
  byContactOrg(contactSfId: string, orgSfId: string): AffiliationEntry[] { return this.contactOrg.get(`${contactSfId}|${orgSfId}`) ?? []; }
  byWorkEmail(email: string): AffiliationEntry | null { return this.email.get(email.trim().toLowerCase()) ?? null; }
  byContact(contactSfId: string): AffiliationEntry[] { return this.contact.get(contactSfId) ?? []; }
  bySfId(sfId: string): AffiliationEntry | null { return this.id.get(sfId) ?? null; }
}

export type OpportunityAttribution =
  | { affiliationSfId: string }
  | { unaffiliated: { contactSfId: string; orgSfId: string } }
  | null;

// NPSP's org-gift shape: AccountId is the organization and Primary Contact is the person who
// drove it. An individual's own gift carries their One-to-One household Account instead, so
// the org-Account check is what separates "acting for" from "as themselves".
export const MATCHING_GIFT_TYPE = 'Matching Donation';

export function attributeOpportunity(
  o: Record<string, unknown>, index: AffiliationIndex, orgAccountIds: ReadonlySet<string>,
): OpportunityAttribution {
  // A Benevity matching gift is the employee's own gift the company matched — the employee
  // did not act for the company, so it is never "Acting for" (Matched By carries the payer).
  if (((o['RecordType'] as { Name?: string } | null)?.Name ?? '') === MATCHING_GIFT_TYPE) return null;
  const orgSfId = o['AccountId'] as string | null;
  const contactSfId = o['npsp__Primary_Contact__c'] as string | null;
  if (!orgSfId || !contactSfId || !orgAccountIds.has(orgSfId)) return null;
  const tenure = pickAffiliation(index.byContactOrg(contactSfId, orgSfId), o['CloseDate'] as string | null);
  return tenure ? { affiliationSfId: tenure.sfId } : { unaffiliated: { contactSfId, orgSfId } };
}

export interface RegistrationAttribution { affiliationSfId: string; attribution: 'Auto' | 'Needs review' }

// Matches the registration email against work addresses only — it never checks WHO registered.
// If the registrant isn't the person that work address belongs to (e.g. X registers using Y's
// work address), the match still resolves but is flagged Needs review instead of Auto so a human
// confirms the "Acting for" link before it's trusted.
export function attributeRegistration(r: Record<string, unknown>, index: AffiliationIndex): RegistrationAttribution | null {
  const email = r['funraise__Email__c'] as string | null;
  if (!email) return null;
  const entry = index.byWorkEmail(email);
  if (!entry) return null;
  const registrantId = r['funraise__Registrant__c'] as string | null;
  const attribution = registrantId && registrantId !== entry.contactSfId ? 'Needs review' : 'Auto';
  return { affiliationSfId: entry.sfId, attribution };
}

export function attributionColumns(affiliationSfId: string | null, label: 'Auto' | 'Needs review' = 'Auto'): {
  columns: Record<string, unknown>; links: { column: string; targetSfIds: string[] }[];
} {
  return affiliationSfId
    ? { columns: { 'Attribution': { label } }, links: [{ column: 'Acting for', targetSfIds: [affiliationSfId] }] }
    : { columns: { 'Attribution': { label: 'None' } }, links: [] };
}

export interface AttributionRollup { giving: number; giftCount: number; lastGiftISO: string | null }

// Posted only — the same rule as transform/rollups.ts, for the same reconciliation reason.
export function attributionRollups(
  opportunities: readonly Record<string, unknown>[], attributed: ReadonlyMap<string, string>, index: AffiliationIndex,
): { byAffiliation: Map<string, AttributionRollup>; organizationalGivingByContact: Map<string, number> } {
  const cents = new Map<string, number>(), count = new Map<string, number>(), last = new Map<string, string>();
  for (const o of opportunities) {
    const af = attributed.get(o['Id'] as string);
    if (!af || o['StageName'] !== 'Posted') continue;
    cents.set(af, (cents.get(af) ?? 0) + Math.round(Number(o['Amount'] ?? 0) * 100));
    count.set(af, (count.get(af) ?? 0) + 1);
    const d = (o['CloseDate'] as string | null)?.slice(0, 10);
    if (d && (!last.has(af) || d > last.get(af)!)) last.set(af, d);
  }
  const byAffiliation = new Map<string, AttributionRollup>();
  for (const [af, c] of cents) byAffiliation.set(af, { giving: c / 100, giftCount: count.get(af) ?? 0, lastGiftISO: last.get(af) ?? null });
  const orgCents = new Map<string, number>();
  for (const [af, c] of cents) {
    const contact = index.bySfId(af)?.contactSfId;
    if (contact) orgCents.set(contact, (orgCents.get(contact) ?? 0) + c);
  }
  const organizationalGivingByContact = new Map<string, number>();
  for (const [contact, c] of orgCents) organizationalGivingByContact.set(contact, c / 100);
  return { byAffiliation, organizationalGivingByContact };
}
