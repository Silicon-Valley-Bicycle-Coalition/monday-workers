import { fiscalYearFromDate } from './compute';

// Donations-side labels for charts and grouping (spec 2026-09-29 §4 and §10.1). Monday charts
// can only group by status/group/person/date, so these are status labels written by the
// custodian's classify duty, not formula columns. '' clears a status cell.

export interface GiftFacts { amountCents: number | null; dateISO: string | null; giftType: string | null }
export interface GiftClassification { fundingStream: string; giftSize: string; fiscalQuarter: string; giftFiscalYear: string }

export const FUNDING_STREAMS = [
  'Individual Giving', 'Membership', 'Sponsorships', 'Grants & Contracts',
  'Matching Donations', 'Other Program Revenue', 'Donor Advised Funds', 'Event Tickets',
] as const;

// Gift Type holds Salesforce RecordType display names ("Matching Donation"); the migration
// plan's original formula used developer names ("MatchingDonation"). Normalizing lets both —
// and stray case/whitespace from hand entry — match (spec §10.3).
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const STREAM_BY_TYPE = new Map<string, string>([
  ['membership', 'Membership'],
  ['sponsorship', 'Sponsorships'],
  ['inkinddonationsponsorship', 'Sponsorships'],
  ['grants', 'Grants & Contracts'],
  ['grant', 'Grants & Contracts'],
  ['contracts', 'Grants & Contracts'],
  ['contract', 'Grants & Contracts'],
  ['matchingdonation', 'Matching Donations'],
  ['commuteworkshop', 'Other Program Revenue'],
  ['drivertraining', 'Other Program Revenue'],
  ['donoradvisedfund', 'Donor Advised Funds'],
  ['eventticket', 'Event Tickets'],
]);

// The $200 and $1k edges are the Salesforce "Donation size" buckets staff reported on for years
// (up to $200 / $200–$1k / $1k+), so those three sum exactly from these five. $200 is also the
// Major acknowledgment threshold below.
export const GIFT_SIZES = ['< $100', '$100–199', '$200–999', '$1k–4.9k', '$5k+'] as const;
const SIZE_UPPER_BOUNDS: [number, string][] = [
  [10000, '< $100'], [20000, '$100–199'], [100000, '$200–999'], [500000, '$1k–4.9k'],
];

function giftSize(amountCents: number | null): string {
  if (amountCents === null || !Number.isFinite(amountCents) || amountCents <= 0) return '';
  for (const [bound, label] of SIZE_UPPER_BOUNDS) if (amountCents < bound) return label;
  return '$5k+';
}

// Acknowledgment Tier (docs/22 §3.4): Major at $200 and up. The board's native automations set
// it on create and on Amount change; classify re-derives it nightly as a backstop. null = no
// usable amount, so the cell is left as it is (as the automations and the one-time backfill do).
const MAJOR_TIER_CENTS = 20000;
export function acknowledgmentTier(amountCents: number | null): string | null {
  if (amountCents === null || !Number.isFinite(amountCents)) return null;
  return amountCents >= MAJOR_TIER_CENTS ? 'Major' : 'Standard';
}

function validDate(dateISO: string | null): string | null {
  if (!dateISO) return null;
  const d = dateISO.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? d : null;
}

// Fiscal Year Ending, as the text the board column holds ("2026" for July 2025 – June 2026), or
// null when the date is unusable. Same rule as salesforce-import and funraise-sync stamp.
export function fiscalYearEnding(dateISO: string | null, fiscalYearStartMonth: number): string | null {
  const date = validDate(dateISO);
  return date ? String(fiscalYearFromDate(date, fiscalYearStartMonth)) : null;
}

export function classifyGift(g: GiftFacts, fiscalYearStartMonth: number): GiftClassification {
  const fundingStream = (g.giftType && STREAM_BY_TYPE.get(norm(g.giftType))) || 'Individual Giving';
  const date = validDate(g.dateISO);
  let fiscalQuarter = '', giftFiscalYear = '';
  if (date) {
    const fy = fiscalYearFromDate(date, fiscalYearStartMonth);
    const month = Number(date.slice(5, 7));
    const quarter = Math.floor(((month - fiscalYearStartMonth + 12) % 12) / 3) + 1;
    fiscalQuarter = `FY${String(fy % 100).padStart(2, '0')} Q${quarter}`;
    giftFiscalYear = `FY${fy}`;
  }
  return { fundingStream, giftSize: giftSize(g.amountCents), fiscalQuarter, giftFiscalYear };
}
