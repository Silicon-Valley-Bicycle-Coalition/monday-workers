// The Annual Impact Report's donor roll call (monday-migration docs/40), computed per fiscal
// year: one row per household, individual, organization or the pooled anonymous donors, with the
// year's total sorted into the report's recognition tiers. A port of monday-migration's
// scripts/donor-roll-call.mjs, in integer cents. Pure: the reads and writes live elsewhere.
import { formatCents } from '../money';

// The report outline's tiers (2025-26 Annual Report Outline, section 11), highest first.
export const TIERS_CENTS: readonly number[] = [5_000_000, 2_500_000, 1_000_000, 500_000, 250_000, 100_000, 50_000, 10_000];
export const RECEIVED_LABELS: readonly string[] = ['Received', 'Received (Historical)'];

export function tierFor(cents: number): string {
  const min = TIERS_CENTS.find((t) => cents >= t);
  return min === undefined ? 'Under $100' : `$${(min / 100).toLocaleString('en-US')}+`;
}

export interface CountedGift {
  giftItemId: string;
  fiscalYear: number;
  cents: number;
  // 'item:<id>' (a Donor or Matched By item), 'anonymous', or 'unplaced' (no one to credit).
  credit: string;
  // A matching gift with no Matched By company: credited to the employee, flagged for review.
  unmatchedMatch: boolean;
}

export interface DonorRecord {
  kind: 'person' | 'organization';
  name: string;
  // Household Greeting for a person, Recognition Name for an organization; '' when blank.
  recognitionName: string;
  householdId: string;
  householdEmail: string;
  doNotSolicit: boolean;
  dontList: boolean;
}

export interface RollCallRow {
  key: string; // '<fiscal year>|household:<id>' | '<fiscal year>|item:<id>' | '<fiscal year>|anonymous'
  fiscalYear: number;
  name: string;
  tier: string;
  type: 'Household' | 'Individual' | 'Organization' | 'Anonymous';
  listed: 'Listed' | "Don't list";
  totalCents: number;
  gifts: number;
  personIds: string[];
  organizationId: string | null;
  reviewNote: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface Group { fiscalYear: number; totalCents: number; gifts: number; unmatchedCents: number; ids: Set<string> }

export function buildRollCall(
  gifts: CountedGift[], donors: Map<string, DonorRecord>,
): { rows: RollCallRow[]; unplaced: { gifts: number; cents: number } } {
  const unplaced = { gifts: 0, cents: 0 };
  const groupKey = (id: string, d: DonorRecord): string =>
    d.kind === 'person' && oneLine(d.householdId) ? `household:${oneLine(d.householdId)}` : `item:${id}`;

  const groups = new Map<string, Group>();
  for (const g of gifts) {
    const id = g.credit.startsWith('item:') ? g.credit.slice(5) : null;
    const donor = id === null ? undefined : donors.get(id);
    if (g.credit !== 'anonymous' && donor === undefined) {
      unplaced.gifts++;
      unplaced.cents += g.cents;
      continue;
    }
    const key = `${g.fiscalYear}|${donor === undefined ? 'anonymous' : groupKey(id!, donor)}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { fiscalYear: g.fiscalYear, totalCents: 0, gifts: 0, unmatchedCents: 0, ids: new Set() };
      groups.set(key, group);
    }
    group.totalCents += g.cents;
    group.gifts++;
    if (g.unmatchedMatch) group.unmatchedCents += g.cents;
    if (id !== null) group.ids.add(id);
  }
  // Every person sharing a Household ID belongs on the household row, even one who didn't give
  // that year, so the row links the whole household.
  for (const [key, group] of groups) {
    const household = key.slice(key.indexOf('|') + 1);
    if (!household.startsWith('household:')) continue;
    for (const [id, d] of donors) if (d.kind === 'person' && groupKey(id, d) === household) group.ids.add(id);
  }

  // A Household Email shared across different rows of one year: a couple that wasn't grouped.
  const rowsByEmail = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    for (const id of group.ids) {
      const email = oneLine(donors.get(id)!.householdEmail).toLowerCase();
      if (!email) continue;
      const scoped = `${group.fiscalYear}|${email}`;
      let keys = rowsByEmail.get(scoped);
      if (keys === undefined) rowsByEmail.set(scoped, keys = new Set());
      keys.add(key);
    }
  }

  const rows: RollCallRow[] = [];
  for (const [key, group] of groups) {
    const base = { key, fiscalYear: group.fiscalYear, tier: tierFor(group.totalCents), totalCents: group.totalCents, gifts: group.gifts };
    if (group.ids.size === 0) {
      rows.push({ ...base, name: 'Anonymous', type: 'Anonymous', listed: 'Listed', personIds: [], organizationId: null, reviewNote: '' });
      continue;
    }
    const ids = [...group.ids];
    const members = ids.map((id) => ({ id, ...donors.get(id)! }));
    const notes: string[] = [];
    let name: string;
    let type: RollCallRow['type'];
    if (members[0]!.kind === 'organization') {
      name = oneLine(members[0]!.recognitionName) || oneLine(members[0]!.name);
      type = 'Organization';
    } else {
      const greetings = [...new Set(members.map((m) => oneLine(m.recognitionName)).filter(Boolean))];
      if (greetings.length > 1) notes.push(`members' Household Greetings differ: ${greetings.join(' / ')}`);
      name = greetings[0] ?? oneLine(members[0]!.name);
      type = members.length > 1 ? 'Household' : 'Individual';
    }
    const dns = members.filter((m) => m.doNotSolicit).map((m) => oneLine(m.name));
    if (dns.length) notes.push(`Do Not Solicit is checked on ${dns.join(', ')}`);
    if (group.unmatchedCents) {
      notes.push(`includes $${formatCents(group.unmatchedCents)} of employer matching with no Matched By company`);
    }
    const sharing = new Set<string>();
    for (const m of members) {
      const email = oneLine(m.householdEmail).toLowerCase();
      for (const other of rowsByEmail.get(`${group.fiscalYear}|${email}`) ?? []) if (other !== key) sharing.add(other);
    }
    if (sharing.size) {
      const names = [...sharing].map((k) => [...groups.get(k)!.ids].map((id) => oneLine(donors.get(id)!.name)).join(' & '));
      notes.push(`shares a Household Email with ${names.join(', ')} — same household?`);
    }
    const isOrg = type === 'Organization';
    rows.push({
      ...base, name, type,
      listed: members.some((m) => m.dontList) ? "Don't list" : 'Listed',
      personIds: isOrg ? [] : ids,
      organizationId: isOrg ? ids[0]! : null,
      reviewNote: notes.join('; '),
    });
  }
  rows.sort((a, b) => b.fiscalYear - a.fiscalYear || b.totalCents - a.totalCents || a.name.localeCompare(b.name));
  return { rows, unplaced };
}
