// The organization year-end statement, pure: what an organization gave (and what its employees'
// matched gifts added) in a completed year. Matches never carry a name.
import type { OrgGift } from '../monday/client';
import type { TaxLetterConfig } from '../types';
import { formatUsd } from '../money';
import { giftYear, parseAmount, splitForLetter } from '../letters/loadLetterData';

export interface OrgStatement {
  org: { id: string; name: string; address: string };
  year: number;
  // One row per Gift Type group, then "Employee matching" when there are matches.
  summary: { label: string; count: number; total: string }[];
  totalSupport: string;
  groups: { label: string; gifts: OrgGift[]; subtotal: string }[];
  matches: { date: string; amount: string }[];
  matchTotal: string;
  // null below the volunteer floor or when volunteer history is off.
  volunteering: { people: number; hours: string } | null;
  acknowledgment: { gifts: OrgGift[]; separateGifts: OrgGift[]; total: string; statement: string } | null;
  // Whether any gift is acknowledgeable (not excluded), whatever the acknowledgment switch says.
  hasDeductibleGifts: boolean;
}

export const OTHER_GROUP_LABEL = 'Other';
export const MATCHING_LABEL = 'Employee matching';

const sum = (gifts: OrgGift[]) => gifts.reduce((total, g) => total + parseAmount(g.amount), 0);
const byDate = (a: OrgGift, b: OrgGift) => a.date.localeCompare(b.date);

// A match that is also a gift (the same Donations item) is one contribution; the gift wins.
function distinctMatches(gifts: OrgGift[], matches: OrgGift[]): OrgGift[] {
  const giftIds = new Set(gifts.map((g) => g.itemId));
  return matches.filter((m) => !giftIds.has(m.itemId));
}

export function buildStatement(input: {
  org: { id: string; name: string; address: string };
  year: number;
  gifts: OrgGift[];
  matches: OrgGift[];
  volunteerHoursByPerson: Map<string, number> | null;
  employeeIds: string[];
  taxLetter: TaxLetterConfig;
  volunteerFloor: number;
  acknowledgmentOn: boolean;
}): OrgStatement | null {
  const inYear = (g: OrgGift) => giftYear(g.date) === input.year;
  const gifts = input.gifts.filter(inYear).sort(byDate);
  const matches = distinctMatches(input.gifts, input.matches).filter(inYear).sort(byDate);
  if (gifts.length === 0 && matches.length === 0) return null;

  const grouped = new Map<string, OrgGift[]>();
  for (const gift of gifts) {
    const label = gift.giftType.trim() || OTHER_GROUP_LABEL;
    grouped.set(label, [...(grouped.get(label) ?? []), gift]);
  }
  // Group order follows each group's earliest gift.
  const groups = [...grouped].map(([label, list]) => ({ label, gifts: list, subtotal: formatUsd(sum(list)) }));

  const matchTotal = sum(matches);
  const summary = groups.map((g) => ({ label: g.label, count: g.gifts.length, total: g.subtotal }));
  if (matches.length > 0) summary.push({ label: MATCHING_LABEL, count: matches.length, total: formatUsd(matchTotal) });

  // The letter rules read a gift's Gift Type as `description`.
  const { acknowledged, separate } = splitForLetter(
    gifts.map((gift) => ({ gift, description: gift.giftType })),
    input.taxLetter
  );
  // Matches the person letter: a DAF-only year is not a tax receipt, so only acknowledged gifts
  // count as deductible; separate gifts are still listed when the acknowledgment is on.
  const hasDeductibleGifts = acknowledged.length > 0;
  let acknowledgment: OrgStatement['acknowledgment'] = null;
  if (input.acknowledgmentOn && (hasDeductibleGifts || separate.length > 0)) {
    const ack = acknowledged.map((e) => e.gift);
    acknowledgment = {
      gifts: ack,
      separateGifts: separate.map((e) => e.gift),
      total: formatUsd(sum(ack)),
      statement: input.taxLetter.plainStatement,
    };
  }

  return {
    org: input.org,
    year: input.year,
    summary,
    totalSupport: formatUsd(sum(gifts) + matchTotal),
    groups,
    matches: matches.map((m) => ({ date: m.date, amount: m.amount })),
    matchTotal: formatUsd(matchTotal),
    volunteering: volunteering(input.volunteerHoursByPerson, input.employeeIds, input.volunteerFloor),
    acknowledgment,
    hasDeductibleGifts,
  };
}

function volunteering(hoursByPerson: Map<string, number> | null, employeeIds: string[], floor: number) {
  if (hoursByPerson === null) return null;
  let people = 0;
  let hours = 0;
  for (const id of new Set(employeeIds)) {
    const h = hoursByPerson.get(id) ?? 0;
    if (h > 0) {
      people += 1;
      hours += h;
    }
  }
  if (people < floor) return null;
  return { people, hours: Number.isInteger(hours) ? String(hours) : hours.toFixed(1) };
}

// Completed calendar years (UTC, as the person letters) with a gift or a match, newest first.
export function statementYears(gifts: OrgGift[], matches: OrgGift[], now: Date): number[] {
  const current = now.getUTCFullYear();
  const years = new Set<number>();
  for (const g of [...gifts, ...matches]) {
    const y = giftYear(g.date);
    if (y !== null && y < current) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}
