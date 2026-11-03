import type { DtdSyncConfig } from '../config';
import { DtdApiError, type DtdClient } from '../dtd/client';
import type { DtdMondayClient, PersonItem } from '../monday/client';
import { getPush, recordPush, recordPushFailure } from '../db/pushes';
import { hasDtdRecordForItem } from '../db/records';
import { pushDecision, windowFloor } from '../mapping/eligibility';

export interface PushDeps {
  dtd: Pick<DtdClient, 'registerDonation'>;
  monday: DtdMondayClient;
  db: D1Database;
  config: DtdSyncConfig;
}

export interface PushResult { considered: number; sent: number; failed: number }

const TIME_ZONE = 'America/Los_Angeles';

/** Today's date (YYYY-MM-DD) in Los Angeles. */
function todayLosAngeles(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** `date` (YYYY-MM-DD) at 12:00 Los Angeles time, as ISO 8601 with that date's UTC offset. */
export function noonLosAngeles(date: string): string {
  const probe = new Date(`${date}T20:00:00Z`); // 12:00 PST or 13:00 PDT; far from the 02:00 DST switch
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'shortOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (!m) throw new Error(`push: cannot determine ${TIME_ZONE} offset for ${date}`);
  return `${date}T12:00:00${m[1]}${(m[2] ?? '').padStart(2, '0')}:${m[3] ?? '00'}`;
}

/**
 * Register eligible non-Funraise Monday gifts with DTD (which emails the donor). The pushes ledger
 * is written before Monday so a Monday failure can never cause a resend.
 */
export async function runPush(deps: PushDeps, now: Date): Promise<PushResult> {
  const { dtd, monday, db, config } = deps;
  const cfg = config.push;

  const items = await monday.listDonationsDatedSince(windowFloor(cfg, now));
  const donorIds = [...new Set(items.flatMap((i) => (i.donorItemId === null ? [] : [i.donorItemId])))];
  const donors = new Map<string, PersonItem>();
  if (donorIds.length > 0) for (const p of await monday.getPeople(donorIds)) donors.set(p.id, p);

  const today = todayLosAngeles(now);
  let sent = 0;
  let failed = 0;
  let writeFailed = 0;

  for (const item of items) {
    const donor = item.donorItemId === null ? null : (donors.get(item.donorItemId) ?? null);
    if (!pushDecision(item, donor, cfg, now).send || donor === null || donor.email === null || item.date === null || item.amount === null) continue;
    if ((await getPush(db, item.id))?.state === 'sent') continue;
    if (await hasDtdRecordForItem(db, item.id)) continue;

    const identifier = `monday-${item.id}`;
    try {
      await dtd.registerDonation({
        campaign: config.dtd.campaign,
        donation_identifier: identifier,
        donation_amount: item.amount,
        donation_datetime: noonLosAngeles(item.date),
        donor_first_name: donor.firstName,
        donor_last_name: donor.lastName,
        donor_email: donor.email.trim(),
        ...(donor.phone ? { donor_phone: donor.phone } : {}),
      });
    } catch (e) {
      if (!(e instanceof DtdApiError)) throw e; // DtdAuthError (or anything unexpected) stops the run
      await recordPushFailure(db, item.id, identifier, e.message);
      failed++;
      continue;
    }

    await recordPush(db, item.id, identifier, now.toISOString());
    sent++;
    try {
      await monday.updateDonation(item.id, { [config.donations.sentToDtd]: { date: today } });
    } catch {
      writeFailed++;
      console.log(JSON.stringify({ job: 'push', event: 'sent-to-dtd-write-failed', itemId: item.id }));
    }
  }

  console.log(JSON.stringify({ job: 'push', considered: items.length, sent, failed, writeFailed }));
  return { considered: items.length, sent, failed };
}
