import type { ItemPayload } from './types.js';
import { dateCol, fiscalYear, funraiseTransactionLink, pacificDay, ownerAttribution, salesforceDebug } from './fields.js';
import { attributionColumns, MATCHING_GIFT_TYPE } from './attribution.js';

// Closed Won is a distinct label, not plain "Received", on purpose: it's the same
// 438 stale-stage records docs/07 gotcha #4 found (IsWon = false, unlike Posted — see
// gotcha #10). Staff still see the gift succeeded, but donation-rollups (monday-workers)
// filters on Status === 'Received' exactly, so a shared label would silently pull these
// back into ongoing Lifetime Giving totals every time it recomputes, undoing the fix in
// transform/rollups.ts. See docs/17 for the full picklist audit.
// Closed Won is NOT a retired stage, though (#43, migration issue #56, decided 2026-09-30):
// the eb4sf Eventbrite package still writes every paid ticket order as Closed Won, under the
// integration user — see isEventbriteTicketOrder, which takes those out of this table.
// Withdrawn is Failed, not Pending: the donor backed out, so the gift isn't coming.
const STATUS: Record<string, string> = {
  Posted: 'Received', 'Closed Won': 'Received (Historical)', 'Closed Lost': 'Failed', Withdrawn: 'Failed',
};
// Stages that genuinely mean "not received yet" (docs/17). Any other stage still lands as
// Pending so the gift isn't lost, but transform counts it (unknownStages) instead of hiding it.
const PENDING_STAGES = new Set(['Prospecting', 'Pledged', 'Invoiced', 'Not Posted', 'Engaged with Organization']);

export const donationStatus = (stage: unknown): string =>
  typeof stage === 'string' && Object.hasOwn(STATUS, stage) ? STATUS[stage]! : 'Pending';

// Gift Type for an Eventbrite paid ticket order. Same label funraise-sync writes for its paid
// events (`eventGiftTypeValue` in ../../funraise-sync/config/svbc.json) — keep them identical,
// Gift Type is a text column and the dashboards group on the string.
export const EVENT_TICKET_GIFT_TYPE = 'Event Ticket';

// An eb4sf ticket order: Closed Won AND created by the integration user the package runs as
// (config.eventbriteIntegrationUserName). Created-by is the discriminator, not the "Eventbrite"
// name suffix, because the package stamps the user on every order while the name is a
// template a staff member can edit or copy. Ticket revenue counts as giving, so these are
// Received / Event Ticket; the Closed Won gifts individual users keyed in stay historical.
// No configured user → nothing matches, so a fork without the package is unaffected.
export function isEventbriteTicketOrder(o: Record<string, unknown>, integrationUserName?: string | null): boolean {
  if (!integrationUserName || o['StageName'] !== 'Closed Won') return false;
  return (o['CreatedBy'] as { Name?: string } | null)?.Name === integrationUserName;
}

// Opportunity Id → Eventbrite order id, from the eb4sf_orders extract (the order record's Name is
// Eventbrite's id). Stamped on the gift as Eventbrite Order ID — the column eventbrite-sync adopts
// by — so a migrated ticket gift is updated, not duplicated, when its order arrives again by
// webhook or backfill. An Opportunity with more than one order (none as of 2026-10-19) keeps the
// lowest id and is counted, so transform reports it.
export function eventbriteOrderIdsByOpportunity(
  orders: readonly Record<string, unknown>[],
): { byOpportunity: Map<string, string>; multiOrderOpportunities: number } {
  const byOpportunity = new Map<string, string>();
  const multi = new Set<string>();
  for (const o of orders) {
    const oppId = o['eb4sf__Opportunity__c'] as string | null;
    const orderId = typeof o['Name'] === 'string' ? o['Name'].trim() : '';
    if (!oppId || !orderId) continue;
    const prev = byOpportunity.get(oppId);
    if (prev !== undefined && prev !== orderId) multi.add(oppId);
    if (prev === undefined || orderId < prev) byOpportunity.set(oppId, orderId);
  }
  return { byOpportunity, multiOrderOpportunities: multi.size };
}

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

// Row key foldFeeCoverage stamps on a gift that absorbed its fee-coverage split: the fee in dollars.
export const FEE_COVERED = 'feeCoveredAmount';

const cents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Funraise fee coverage (docs/32 finding 3): when a donor covers the processing fee, Salesforce
// saves the fee as a second Opportunity (Funraise_Fee_Match_Opportunity__c), created in the same
// second for the same donor and stage, whose Amount equals the gift's Funraise_Fee_Match_Amount__c
// — 2,166 of them as of 2026-10-26, $0.12–$20. Loaded as gifts of their own they'd add 2,166 to
// Gift Count and drag Smallest/Average Gift to cents, so each paired split is folded into its gift
// instead: the gift's Amount becomes gift + fee (the donor's whole payment, and what NPSP's own
// rollups summed, so reconciliation totals don't move) and FEE_COVERED records the fee part.
// A split with no matching gift stays a gift of its own, so no money drops off the board; the
// caller reports how many.
export function foldFeeCoverage(opportunities: readonly Record<string, unknown>[]): {
  gifts: Record<string, unknown>[]; folded: number; foldedCents: number; unpaired: number;
} {
  const isSplit = (o: Record<string, unknown>) => o['Funraise_Fee_Match_Opportunity__c'] === true;
  const keyOf = (o: Record<string, unknown>, feeCents: number | null) => [
    o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? o['AccountId'] ?? '',
    o['CreatedDate'] ?? '', o['StageName'] ?? '', feeCents ?? '',
  ].join('|');
  // Parents waiting for their split, by key; each takes at most one.
  const parents = new Map<string, Record<string, unknown>[]>();
  for (const o of opportunities) {
    const fee = cents(o['Funraise_Fee_Match_Amount__c']);
    if (isSplit(o) || !fee) continue;
    const key = keyOf(o, fee);
    (parents.get(key) ?? parents.set(key, []).get(key)!).push(o);
  }
  const feeOf = new Map<Record<string, unknown>, number>();
  const absorbed = new Set<Record<string, unknown>>();
  for (const o of opportunities) {
    if (!isSplit(o)) continue;
    const fee = cents(o['Amount']);
    const parent = fee ? parents.get(keyOf(o, fee))?.shift() : undefined;
    if (!parent || !fee) continue;
    feeOf.set(parent, fee);
    absorbed.add(o);
  }
  let foldedCents = 0;
  const gifts = opportunities.filter((o) => !absorbed.has(o)).map((o) => {
    const fee = feeOf.get(o);
    if (fee === undefined) return o;
    foldedCents += fee;
    return { ...o, Amount: ((cents(o['Amount']) ?? 0) + fee) / 100, [FEE_COVERED]: fee / 100 };
  });
  const splits = opportunities.filter(isSplit).length;
  return { gifts, folded: absorbed.size, foldedCents, unpaired: splits - absorbed.size };
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
  // One-to-One Individual Accounts, which never become items. A donor still resolving to one
  // after donorAlias (no sole migrated Contact — people.ts soleContactAccountIds) gets no Donor
  // link rather than a dangling one.
  personAccountIds?: ReadonlySet<string>;
}

export interface OpportunityDeps extends DonorResolution {
  termCols: Map<string, Record<string, unknown>>;
  softCredits?: readonly string[];
  // See isEventbriteTicketOrder. Omit (or null) to map every Closed Won gift as historical.
  eventbriteIntegrationUserName?: string | null;
  // See eventbriteOrderIdsByOpportunity.
  eventbriteOrderId?: string | null;
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
  return raw && !deps.placeholderDonorSfIds?.has(raw) && !deps.personAccountIds?.has(raw) ? raw : null;
}

export function opportunityToPayload(o: Record<string, unknown>, deps: OpportunityDeps): ItemPayload {
  const orgAccountIds = deps.orgAccountIds ?? new Set<string>();
  const accountId = o['AccountId'] as string | null;
  const donorId = giftDonorSfId(o, deps);
  // A donor dropped only because it is a One-to-One Account is unresolved, not anonymous.
  const unresolvedPerson = !donorId && !!deps.personAccountIds && giftDonorSfId(o, { ...deps, personAccountIds: undefined }) !== null;
  const ticketOrder = isEventbriteTicketOrder(o, deps.eventbriteIntegrationUserName);
  const type = ticketOrder ? EVENT_TICKET_GIFT_TYPE : giftType(o);
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
      'Status': { label: ticketOrder ? 'Received' : donationStatus(o['StageName']) },
      'Gift Type': type,
      'Funraise ID': funraiseTransactionLink(o['funraise__fr_ID__c']),
      'Anonymous Donor': donorId || unresolvedPerson ? null : { checked: 'true' },
      // Salesforce never stored Benevity's transaction id, so this is blank on every migrated
      // gift; declared here so load creates the column for the benevity-import Worker to fill.
      'Benevity Transaction ID': '',
      // Always declared, so load creates the column eventbrite-sync writes and adopts by.
      'Eventbrite Order ID': deps.eventbriteOrderId ?? '',
      'Fee Covered': o[FEE_COVERED] != null ? String(o[FEE_COVERED]) : '',
      'Finance Class': text(o['Finance_Class__c']),
      'Revenue Code': text(o['Finance_Revenue_Code__c']),
      'Payment Method': text(o['Payment_Method__c']),
      'Check/Reference Number': text(o['Check_Reference_Number__c']),
      'In-Kind Value': o['Retail_Value__c'] != null ? String(o['Retail_Value__c']) : '',
      'In-Kind Category': text(o['In_Kind_Category__c']),
      // A multi-select picklist (e.g. "2023-2024 BTWD;2024 Summit"), kept as readable text.
      'Sponsorship Cycle': text(o['Sponsorship_Cycle__c']).split(';').map((v) => v.trim()).filter(Boolean).join('; '),
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

// TransactionDate is a true datetime, unlike CloseDate. Its Pacific day is the gift date: it's what
// Salesforce displays, and the CloseDate on all 929 of the paired Opportunities whose UTC and Pacific
// days differ (2026-11-03).
export const cnpGiftDay = (tx: Record<string, unknown>): string | null =>
  pacificDay(tx['CnP_PaaS__TransactionDate__c'] as string | null);

export function cnpToPayload(tx: Record<string, unknown>, donorAlias?: Map<string, string>,
  personAccountIds?: ReadonlySet<string>): ItemPayload {
  const resolved = resolveDonor(tx['CnP_PaaS__Contact__c'] ?? tx['CnP_PaaS__Account__c'], donorAlias);
  const donorId = resolved && !personAccountIds?.has(resolved) ? resolved : null;
  const day = cnpGiftDay(tx);
  return {
    board: 'donations',
    sfId: tx['Id'] as string,
    name: (tx['Name'] as string) ?? '(C&P transaction)',
    columns: {
      'Amount': tx['CnP_PaaS__TotalCharged__c'] != null ? String(tx['CnP_PaaS__TotalCharged__c']) : '',
      'Date': dateCol(day),
      'Fiscal Year Ending': fiscalYear(day),
      'Status': { label: 'Received' },
      'Gift Type': 'Click & Pledge (historical)',
      ...salesforceDebug(tx),
    },
    links: donorId ? [{ column: 'Donor', targetSfIds: [donorId] }] : [],
  };
}
