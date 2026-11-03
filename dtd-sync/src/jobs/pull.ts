import type { DtdSyncConfig } from '../config';
import { DtdAuthError, type DtdClient } from '../dtd/client';
import type { DtdDonation } from '../dtd/types';
import type { DonationItem, DtdMondayClient } from '../monday/client';
import { getRecord, listUnmatched, upsertRecord, type StoredRecord } from '../db/records';
import { getWatermark, setWatermark } from '../db/state';
import { matchStatusLabel } from '../mapping/status';
import { fiscalYearBounds, fiscalYearOf } from '../reporting/summary';
import { logItemFailure } from '../logSafe';

export interface PullDeps {
  dtd: Pick<DtdClient, 'getUpdatedDonations'>;
  monday: DtdMondayClient;
  db: D1Database;
  config: DtdSyncConfig;
}

export interface PullResult { fetched: number; written: number; unmatched: number }

const UNMATCHED_RETRY_LIMIT = 50;
const MONDAY_PREFIX = 'monday-';
const MATCHED = 'Matched';

function toISO(value: string | null): string | null {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function str(value: string | number | null): string | null {
  return value === null || value === '' ? null : String(value);
}

/** The Monday Donations item a DTD record belongs to, or null while it can't be found. */
async function resolve(monday: DtdMondayClient, identifier: string, source: string | null): Promise<DonationItem | null> {
  if (identifier.startsWith(MONDAY_PREFIX)) return monday.getDonation(identifier.slice(MONDAY_PREFIX.length));
  return source === null ? monday.findDonationByFunraiseId(identifier) : monday.findDonationBySalesforceId(identifier);
}

function differs(prev: StoredRecord | null, next: StoredRecord): boolean {
  return (
    prev === null ||
    prev.unmatched ||
    prev.mondayItemId !== next.mondayItemId ||
    prev.status !== next.status ||
    prev.matchingGiftStatus !== next.matchingGiftStatus ||
    prev.employerStatus !== next.employerStatus ||
    prev.companyName !== next.companyName ||
    prev.matchedAmount !== next.matchedAmount
  );
}

interface Handled { written: boolean; unmatched: boolean; error?: unknown }

/**
 * Resolve, write (when changed) and store one DTD record. A Monday failure part-way stores the
 * record as unmatched (keeping any known item id) so the retry pass re-handles it, and comes back
 * as `error`; only a D1 failure (or DtdAuthError) throws.
 */
async function handle(deps: PullDeps, d: DtdDonation, plugin: string | null, nowISO: string): Promise<Handled> {
  const { monday, db, config } = deps;
  const prev = await getRecord(db, d.donation_identifier);

  const next: StoredRecord = {
    donationIdentifier: d.donation_identifier,
    mondayItemId: prev?.mondayItemId ?? null,
    source: d.source,
    status: d.status,
    matchingGiftStatus: d.matching_gift_status,
    employerStatus: d.employer_identification_status,
    companyId: str(d.doublethedonation_company_id),
    companyName: d.company_name,
    matchedAmount: d.matched_amount,
    donationDatetime: toISO(d.donation_datetime),
    updatedSeenAt: nowISO,
    unmatched: true, // a carried-forward item id stays retryable until it resolves
  };

  let written = false;
  try {
    const item = await resolve(monday, d.donation_identifier, d.source);
    if (item) {
      next.mondayItemId = item.id;
      next.unmatched = false;
    }
    if (item && differs(prev, next)) {
      if (item.matchStatus !== MATCHED) {
        const keyword = d.matching_gift_status ?? d.status;
        await monday.updateDonation(item.id, {
          [config.donations.matchStatus]: { label: matchStatusLabel(keyword, config.statusLabels, false) },
          [config.donations.dtdStatusRaw]: keyword ?? '',
          [config.donations.matchCompany]: d.company_name ?? '',
        });
        written = true;
      }
      await writePerson(deps, item, next.companyId, d.company_name, plugin);
    }
  } catch (err) {
    if (err instanceof DtdAuthError) throw err;
    // Retryable: unmatched rows always count as changed, so the retry pass rewrites everything.
    await upsertRecord(db, { ...next, unmatched: true });
    return { written, unmatched: false, error: err };
  }

  await upsertRecord(db, next);
  return { written, unmatched: next.unmatched };
}

async function writePerson(deps: PullDeps, item: DonationItem, companyId: string | null, companyName: string | null, link: string | null): Promise<void> {
  if (companyId === null || item.donorItemId === null) return;
  const [person] = await deps.monday.getPeople([item.donorItemId]);
  if (!person || person.dtdCompanyId === companyId) return;
  const p = deps.config.people;
  const values: Record<string, unknown> = { [p.dtdCompanyId]: companyId, [p.dtdCompany]: companyName ?? '' };
  if (link !== null && /^https:\/\//i.test(link)) values[p.dtdLink] = { url: link, text: 'Start your match' };
  await deps.monday.updatePerson(person.id, values);
}

function asDonation(r: StoredRecord): DtdDonation {
  return {
    donation_identifier: r.donationIdentifier, source: r.source, donation_datetime: r.donationDatetime, donor_email: null,
    company_name: r.companyName, doublethedonation_company_id: r.companyId, status: r.status,
    matching_gift_status: r.matchingGiftStatus, employer_identification_status: r.employerStatus,
    matched_amount: r.matchedAmount, plugin_link: null,
  };
}

/** First run (no watermark): July 1 00:00 UTC of the previous fiscal year, so a whole FY of matches comes back. */
export function firstPullSince(now: Date): string {
  const fy = fiscalYearOf(now.toISOString());
  return fiscalYearBounds(`FY${Number(fy.slice(2)) - 1}`).startISO;
}

/**
 * Pull DTD changes onto Monday. Unmatched records, and records whose Monday write failed, are
 * stored and retried next run without blocking the watermark; it is held back only when a
 * fetched record could not be stored at all.
 */
export async function runPull(deps: PullDeps, now: Date): Promise<PullResult> {
  const nowISO = now.toISOString();
  const watermark = await getWatermark(deps.db);
  const since = watermark
    ? new Date(new Date(watermark).getTime() - deps.config.dtd.pullOverlapMinutes * 60_000).toISOString()
    : firstPullSince(now);

  const donations = await deps.dtd.getUpdatedDonations(since, nowISO); // DtdAuthError propagates

  let written = 0;
  let unmatched = 0;
  let failed = 0; // Monday failed; stored for retry
  let lost = 0; // couldn't be stored either; holds the watermark
  const seen = new Set<string>();
  for (const d of donations) {
    seen.add(d.donation_identifier);
    try {
      const r = await handle(deps, d, d.plugin_link, nowISO);
      if (r.written) written++;
      if (r.unmatched) unmatched++;
      if (r.error !== undefined) {
        failed++;
        logItemFailure('pull', d.donation_identifier, r.error);
      }
    } catch (err) {
      if (err instanceof DtdAuthError) throw err;
      failed++;
      lost++;
      logItemFailure('pull', d.donation_identifier, err);
    }
  }

  // Retry stored unmatched/failed records; these never block the watermark. Each retried row's
  // updatedSeenAt moves to now, so listUnmatched (oldest first) rotates past rows that keep failing.
  let retryFailed = 0;
  for (const r of await listUnmatched(deps.db, UNMATCHED_RETRY_LIMIT)) {
    if (seen.has(r.donationIdentifier)) continue;
    try {
      const out = await handle(deps, asDonation(r), null, nowISO);
      if (out.written) written++;
      if (out.unmatched) unmatched++;
      if (out.error !== undefined) {
        retryFailed++;
        logItemFailure('pull', r.donationIdentifier, out.error);
      }
    } catch (err) {
      if (err instanceof DtdAuthError) throw err;
      retryFailed++;
      logItemFailure('pull', r.donationIdentifier, err);
    }
  }

  if (lost === 0) await setWatermark(deps.db, nowISO);
  console.log(JSON.stringify({ job: 'pull', fetched: donations.length, written, unmatched, failed, lost, retryFailed }));
  return { fetched: donations.length, written, unmatched };
}
