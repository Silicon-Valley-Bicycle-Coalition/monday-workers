import type { DtdSyncConfig, OutreachConfig } from '../config';
import { daysBefore, todayLosAngeles } from '../dates';
import type { DonationItem, PersonItem, PromptDonor } from '../monday/client';
import { promptVariant, type PromptVariant } from '../outreach/employers';

export type PushConfig = DtdSyncConfig['push'];
export type PushDecision = { send: true } | { send: false; reason: string };

const DAY_MS = 86_400_000;

/** Earliest item Date (YYYY-MM-DD) still eligible: the earlier of now − windowDays and backfillFromISO. */
export function windowFloor(cfg: Pick<PushConfig, 'windowDays' | 'backfillFromISO'>, now: Date): string {
  const rolling = new Date(now.getTime() - cfg.windowDays * DAY_MS).toISOString().slice(0, 10);
  const backfill = cfg.backfillFromISO?.slice(0, 10);
  return backfill !== undefined && backfill < rolling ? backfill : rolling;
}

function allowed(email: string, allow: PushConfig['allowEmails']): boolean {
  if (allow === '*') return true;
  if (allow === null) return false;
  const want = email.trim().toLowerCase();
  return allow.some((a) => a.trim().toLowerCase() === want);
}

/**
 * Whether a Monday gift may be registered with DTD (which then emails the donor).
 * Pure; every "no" carries a short reason so dry runs and tests can see why.
 */
export function pushDecision(item: DonationItem, donor: PersonItem | null, cfg: PushConfig, now: Date): PushDecision {
  const no = (reason: string): PushDecision => ({ send: false, reason });

  // Sent to DTD is set after a successful register; the D1 pushes ledger is the primary guard, this
  // one also covers a ledger that was reset or an item staff marked by hand.
  if (item.sentToDtd) return no('already-sent');

  if (item.giftType === null || !cfg.giftTypes.includes(item.giftType) || cfg.excludeGiftTypes.includes(item.giftType)) return no('gift-type');
  if (item.funraiseId) return no('funraise');
  if (item.benevityTransactionId) return no('benevity');
  if (item.anonymous) return no('anonymous');
  if (item.status !== cfg.receivedStatus) return no('status');
  if (item.amount === null || !(item.amount > 0)) return no('amount');
  if (item.date === null || item.date < windowFloor(cfg, now)) return no('window');
  const email = donor?.email?.trim();
  if (!email) return no('no-email');
  if (!allowed(email, cfg.allowEmails)) return no('not-allow-listed');
  return { send: true };
}

export type PromptDecision = { send: true; variant: PromptVariant } | { send: false; reason: string };

/** What the prompt job looks up about a gift before deciding. */
export interface PromptFacts { pairedGiftIds: ReadonlySet<string>; knownToDtd: boolean; inCooldown: boolean }

/** Match Status once pairing has linked a Matching Donation to the gift. */
export const MATCHED_LABEL = 'Matched';

// pushDecision's reasons that depend on the donor. Every other reason, and the gift rules below, can
// be judged before the donor is read.
const DONOR_REASONS = new Set(['no-email', 'not-allow-listed']);

/**
 * Whether a gift gets the post-gift matching email, and which one: everything pushDecision requires,
 * plus the email's own rules. Pure; like pushDecision, every "no" carries its reason.
 */
export function promptDecision(
  item: DonationItem, donor: PromptDonor | null, push: PushConfig, outreach: OutreachConfig, facts: PromptFacts, now: Date,
): PromptDecision {
  const no = (reason: string): PromptDecision => ({ send: false, reason });

  const base = pushDecision(item, donor, push, now);
  if (!base.send && !DONOR_REASONS.has(base.reason)) return base;
  if (item.giftType === null || outreach.excludeGiftTypes.includes(item.giftType)) return no('gift-type');
  if (item.date === null || item.date > daysBefore(todayLosAngeles(now), outreach.delayDays)) return no('too-recent');
  if (item.matchStatus === MATCHED_LABEL || facts.pairedGiftIds.has(item.id)) return no('paired');
  if (facts.knownToDtd) return no('known-to-dtd');

  if (!base.send) return base;
  if (donor === null) return no('no-email');
  if (donor.doNotSolicit) return no('do-not-solicit');
  if (facts.inCooldown) return no('cooldown');
  const variant = promptVariant(donor.employerName, outreach);
  return variant === null ? no('employer-not-known') : { send: true, variant };
}
