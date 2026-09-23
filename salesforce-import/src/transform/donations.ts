import type { ItemPayload } from './types.js';
import { dateCol, fiscalYear, funraiseTransactionLink, ownerAttribution, salesforceDebug } from './fields.js';
import { attributionColumns, MATCHING_GIFT_TYPE } from './attribution.js';

// Closed Won is a distinct label, not plain "Received", on purpose: it's the same
// 438 stale-stage records docs/07 gotcha #4 found (IsWon = false, unlike Posted — see
// gotcha #10). Staff still see the gift succeeded, but donation-rollups (monday-workers)
// filters on Status === 'Received' exactly, so a shared label would silently pull these
// back into ongoing Lifetime Giving totals every time it recomputes, undoing the fix in
// transform/rollups.ts. See docs/17 for the full picklist audit.
// Withdrawn is Failed, not Pending: the donor backed out, so the gift isn't coming.
const STATUS: Record<string, string> = {
  Posted: 'Received', 'Closed Won': 'Received (Historical)', 'Closed Lost': 'Failed', Withdrawn: 'Failed',
};
// Stages that genuinely mean "not received yet" (docs/17). Any other stage still lands as
// Pending so the gift isn't lost, but transform counts it (unknownStages) instead of hiding it.
const PENDING_STAGES = new Set(['Prospecting', 'Pledged', 'Invoiced', 'Not Posted', 'Engaged with Organization']);

export const donationStatus = (stage: unknown): string =>
  typeof stage === 'string' && Object.hasOwn(STATUS, stage) ? STATUS[stage]! : 'Pending';

// Stage name → gift count for every stage donationStatus doesn't recognise.
export function unknownStages(opportunities: readonly Record<string, unknown>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of opportunities) {
    const stage = o['StageName'] as string | null;
    if (stage && (Object.hasOwn(STATUS, stage) || PENDING_STAGES.has(stage))) continue;
    const key = stage ?? '(blank)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Soft credits (issue #23, decided 2026-09-23): every OpportunityContactRole naming someone other
// than the gift's Primary Contact — Fundraiser, Influencer, Recruiter, Team Captain, a second
// Donor… NPSP also gives the Primary Contact a role of its own (Donor, or Soft Credit on ~5k
// gifts), which Donor/Acting for already carry, and auto-creates a Household Member role for each
// of the donor's housemates, which is derivable from the household and skipped. ~2,750 links on
// ~2,200 gifts as of 2026-09-23. Targets that aren't migrated People are skipped at load.
export function softCreditsByGift(
  roles: readonly Record<string, unknown>[], opportunities: readonly Record<string, unknown>[],
  placeholderDonorSfIds: ReadonlySet<string> = new Set(),
): Map<string, string[]> {
  const primaryOf = new Map(opportunities.map((o) => [o['Id'] as string,
    (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? null) as string | null]));
  const credits = new Map<string, Set<string>>();
  for (const r of roles) {
    const giftId = r['OpportunityId'] as string | null;
    const contactId = r['ContactId'] as string | null;
    if (!giftId || !contactId || !primaryOf.has(giftId)) continue;
    if (r['Role'] === 'Household Member' || contactId === primaryOf.get(giftId)) continue;
    if (placeholderDonorSfIds.has(contactId)) continue;
    (credits.get(giftId) ?? credits.set(giftId, new Set()).get(giftId)!).add(contactId);
  }
  return new Map([...credits].map(([id, set]) => [id, [...set].sort()]));
}

// Donor precedence, then re-pointed through `donorAlias` when the fallback AccountId is a
// person-named Account folded into a Person (people.ts personNamedAccountIds) — otherwise
// the Donor link would target an Organization item that is never created.
const resolveDonor = (raw: unknown, donorAlias?: Map<string, string>): string | null => {
  const id = raw as string | null;
  return id ? (donorAlias?.get(id) ?? id) : null;
};

export interface DonorResolution {
  donorAlias?: Map<string, string>;
  // Accounts that become Organizations items (not One-to-One Individual, not person-named).
  // Only these can be a gift's Matched By target — a matching gift filed under a household
  // Account has no payer link.
  orgAccountIds?: ReadonlySet<string>;
  // Placeholder donor records (config.placeholderDonorSfIds): a gift pointing at one is
  // anonymous — no Donor link, checkbox on — and never falls back to the Account either.
  placeholderDonorSfIds?: ReadonlySet<string>;
  // Affiliation the Primary Contact acted for (transform/attribution.ts).
  actingFor?: string | null;
}

export interface OpportunityDeps extends DonorResolution {
  termCols: Map<string, Record<string, unknown>>;
  softCredits?: readonly string[];
}

export const giftType = (o: Record<string, unknown>): string =>
  ((o['RecordType'] as { Name?: string } | null)?.Name ?? '') as string;

// Who a gift's Donor link points at. Decided 2026-09-11 (affiliation model, Plan 2 entry):
// an organization gift the Primary Contact drove for that organization (Acting for set) is
// the ORGANIZATION's gift — Donor is the org, the person stays reachable through Acting for,
// and Lifetime Giving means personal giving while Organizational Giving means driven giving.
// An org gift nobody has attributed yet keeps the person as Donor (nothing is lost before
// staff resolve data/review/unaffiliated-org-gifts.csv), and a matching gift is the
// employee's own gift the company matched — never re-pointed (Matched By carries the payer).
export function giftDonorSfId(o: Record<string, unknown>, deps: DonorResolution): string | null {
  const accountId = o['AccountId'] as string | null;
  if (deps.actingFor && accountId && deps.orgAccountIds?.has(accountId) && giftType(o) !== MATCHING_GIFT_TYPE) {
    return accountId;
  }
  const raw = resolveDonor(o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? accountId, deps.donorAlias);
  return raw && !deps.placeholderDonorSfIds?.has(raw) ? raw : null;
}

export function opportunityToPayload(o: Record<string, unknown>, deps: OpportunityDeps): ItemPayload {
  const orgAccountIds = deps.orgAccountIds ?? new Set<string>();
  const accountId = o['AccountId'] as string | null;
  const donorId = giftDonorSfId(o, deps);
  const type = giftType(o);
  const attribution = attributionColumns(deps.actingFor ?? null);
  const links: ItemPayload['links'] = [...attribution.links];
  if (donorId) links.push({ column: 'Donor', targetSfIds: [donorId] });
  // Employer matching gifts (Benevity): Donor is the employee the match is credited to (or the
  // company, when Benevity disclosed none); Matched By is always the paying company. Before
  // this, the company was dropped whenever a Primary Contact existed — 2,182 of 3,020 gifts.
  if (type === MATCHING_GIFT_TYPE && accountId && orgAccountIds.has(accountId)) {
    links.push({ column: 'Matched By', targetSfIds: [accountId] });
  }
  if (o['funraise__Subscription__c']) links.push({ column: 'Recurring Gift', targetSfIds: [o['funraise__Subscription__c'] as string] });
  if (o['CampaignId']) links.push({ column: 'Campaign', targetSfIds: [o['CampaignId'] as string] });
  if (deps.softCredits?.length) links.push({ column: 'Soft Credit', targetSfIds: [...deps.softCredits] });
  return {
    board: 'donations',
    sfId: o['Id'] as string,
    name: (o['Name'] as string) ?? '(no name)',
    columns: {
      'Amount': o['Amount'] != null ? String(o['Amount']) : '',
      'Date': dateCol(o['CloseDate'] as string),
      'Fiscal Year Ending': fiscalYear(o['CloseDate'] as string | null),
      'Salesforce Owner': ownerAttribution(o['Owner']),
      'Status': { label: donationStatus(o['StageName']) },
      'Gift Type': type,
      'Funraise ID': funraiseTransactionLink(o['funraise__fr_ID__c']),
      'Anonymous Donor': donorId ? null : { checked: 'true' },
      // Salesforce never stored Benevity's transaction id, so this is blank on every migrated
      // gift; declared here so load creates the column for the benevity-import Worker to fill.
      'Benevity Transaction ID': '',
      ...(deps.termCols.get(o['Id'] as string) ?? {}),
      ...attribution.columns,
      ...salesforceDebug(o),
    },
    links,
  };
}

export function cnpOverlapCheck(
  transactions: Record<string, unknown>[], opportunities: Record<string, unknown>[],
): { duplicateTransactionIds: string[]; unique: Record<string, unknown>[] } {
  const oppOrderNumbers = new Set(opportunities.map((o) => o['CnP_PaaS__CnP_OrderNumber__c']).filter(Boolean));
  const duplicateTransactionIds: string[] = [];
  const unique = transactions.filter((t) => {
    const txId = t['Id'] as string | null;
    if (txId && oppOrderNumbers.has(txId)) { duplicateTransactionIds.push(txId); return false; }
    return true;
  });
  return { duplicateTransactionIds, unique };
}

export function cnpToPayload(tx: Record<string, unknown>, donorAlias?: Map<string, string>): ItemPayload {
  const donorId = resolveDonor(tx['CnP_PaaS__Contact__c'] ?? tx['CnP_PaaS__Account__c'], donorAlias);
  return {
    board: 'donations',
    sfId: tx['Id'] as string,
    name: (tx['Name'] as string) ?? '(C&P transaction)',
    columns: {
      'Amount': tx['CnP_PaaS__TotalCharged__c'] != null ? String(tx['CnP_PaaS__TotalCharged__c']) : '',
      'Date': dateCol(tx['CnP_PaaS__TransactionDate__c'] as string),
      'Fiscal Year Ending': fiscalYear(tx['CnP_PaaS__TransactionDate__c'] as string | null),
      'Status': { label: 'Received' },
      'Gift Type': 'Click & Pledge (historical)',
      ...salesforceDebug(tx),
    },
    links: donorId ? [{ column: 'Donor', targetSfIds: [donorId] }] : [],
  };
}
