import type { DtdSyncConfig } from '../config';
import type { DonationItem, PersonItem } from '../monday/client';

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
