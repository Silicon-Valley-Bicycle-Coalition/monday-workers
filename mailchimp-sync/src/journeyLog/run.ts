// The hourly Journey send log (spec docs/superpowers/specs/2026-11-18-mailchimp-journey-send-log-design.md):
// every Customer Journey email Mailchimp sends becomes a "Mailchimp email" timeline entry on the
// recipient's People item, and the item's Last Journey Email date moves up to it.
//
// 1. Catalog: the audience's Journeys and their send-email steps.
// 2. Read: for each Journey email whose emails_sent moved since its last full read, its sent-to
//    report; new recipients go into journey_sends as `pending` (`dropped` under writes off), and
//    only then does the email's read mark move (the cron-polled-Worker invariant).
// 3. Log: each pending row gets its People item matched, the date column advanced (idempotent),
//    the timeline entry created, then `logged`. A failure leaves the row pending for next hour, so
//    delivery is at-least-once: a crash between the create and the D1 write repeats that entry.
//
// Follows the write switch: `hold`/`unknown` skip the run with nothing read; `off` reads and
// records rows as `dropped`, so sends read then are never logged. Logs carry counts, campaign ids
// and subscriber hashes only, never an address.
import { runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { Config, JourneyLogConfig } from '../types';
import type { JourneySendStore, PendingJourneySend } from '../db/journeySends';
import { redactEmails } from '../logSafe';
import { todayIn } from '../renewalDue/plan';
import type { JourneyEmail, SentToRow } from './mailchimp';
import type { JourneyLogMonday } from './monday';

export const JOURNEY_LOG_CRON = '20 * * * *';
// Stops starting new entries after this, well inside the platform's 15-minute cron limit.
export const JOURNEY_LOG_BUDGET_MS = 10 * 60_000;
const TIME_ZONE = 'America/Los_Angeles';
// A row that fails this many runs in a row (not an outage) stops being retried and is marked
// `failed`, so one bad item can't alert every hour forever.
export const JOURNEY_LOG_MAX_ATTEMPTS = 5;

export interface JourneyLogMailchimp {
  listJourneyEmails(journeyIds: readonly number[] | null): Promise<JourneyEmail[]>;
  readSentTo(campaignId: string): Promise<SentToRow[]>;
  readSendTime(emailId: string, campaignId: string): Promise<string | null>;
  readAddress(emailId: string): Promise<string | null>;
}

export interface JourneyLogDeps {
  config: Config;
  mailchimp: JourneyLogMailchimp;
  monday: JourneyLogMonday;
  store: JourneySendStore;
  isOutage: (err: unknown) => boolean;
  alert: (text: string) => Promise<void>;
  now?: () => number;
}

export interface JourneyLogSummary {
  outcome: 'disabled' | 'skipped' | 'catalog-failed' | 'done';
  mode: WriteMode;
  journeyEmails: number;
  // Journey emails whose sent-to was read this run, and those whose read failed.
  read: number;
  readFailed: number;
  newRows: number;
  logged: number;
  bounces: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
  // Pending rows left for the next run by the cap, the time budget or a Monday outage.
  deferred: number;
  outage: boolean;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');
const errText = (err: unknown): string => redactEmails(err instanceof Error ? err.message : String(err));

// create_timeline_item's limit on title and summary.
const MAX_TIMELINE_TEXT = 255;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The entry's text. Content is HTML (Monday stores and renders it so, as eventbrite-sync's class
// email entries do); title and summary are plain text.
export function entryFor(row: PendingJourneySend, email: JourneyEmail | undefined): { title: string; summary: string; content: string } {
  const subject = email?.subject || 'Mailchimp Journey email';
  const where = email === undefined ? 'a Mailchimp Customer Journey' : `${email.journeyName} · email ${email.position} of ${email.of}`;
  const delivered = row.delivery === 'sent';
  const lead = delivered
    ? `Sent by the Mailchimp Customer Journey ${email === undefined ? '' : `“${email.journeyName}” `}(email ${email?.position ?? '?'} of ${email?.of ?? '?'}).`
    : `Not delivered: a ${row.delivery} bounce. mailchimp-sync's hourly consent sync updates the address's consent column.`;
  const content = `<p>${escapeHtml(lead)}</p>`
    + (email?.archiveUrl ? `<p><a href="${escapeHtml(email.archiveUrl)}">View the email as sent</a></p>` : '');
  return {
    title: (delivered ? subject : `Not delivered: ${subject}`).slice(0, MAX_TIMELINE_TEXT),
    summary: where.slice(0, MAX_TIMELINE_TEXT),
    content,
  };
}

export async function runJourneyLog(gate: BatchSkipContext, deps: JourneyLogDeps): Promise<JourneyLogSummary> {
  const settings: JourneyLogConfig | null = deps.config.journeyLog;
  const now = deps.now ?? Date.now;
  const deadline = now() + JOURNEY_LOG_BUDGET_MS;
  const iso = () => new Date(now()).toISOString();
  const summary: JourneyLogSummary = {
    outcome: 'done', mode: gate.mode, journeyEmails: 0, read: 0, readFailed: 0, newRows: 0, logged: 0,
    bounces: 0, unmatched: 0, ambiguous: 0, failed: 0, deferred: 0, outage: false,
  };
  const prefix = `mailchimp-sync journey-log (${gate.environment}):`;
  if (settings === null) return { ...summary, outcome: 'disabled' };
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`${prefix} write mode is "${gate.mode}"; skipping this run`);
    return { ...summary, outcome: 'skipped' };
  }

  // 1. Catalog.
  let catalog: JourneyEmail[];
  try {
    catalog = await deps.mailchimp.listJourneyEmails(settings.journeyIds);
  } catch (err) {
    // Every hour this fails is an hour of sends not logged; say so rather than stall quietly.
    const text = `${prefix} could not read the Customer Journeys (${errName(err)}: ${errText(err)}); nothing logged this run`;
    console.error(text);
    await deps.alert(text);
    return { ...summary, outcome: 'catalog-failed' };
  }
  summary.journeyEmails = catalog.length;
  const byCampaign = new Map(catalog.map((e) => [e.campaignId, e]));

  // 2. Read new recipients.
  const addresses = new Map<string, string>();
  const counts = await deps.store.getCounts();
  for (const sendStep of catalog) {
    if (sendStep.emailsSent === (counts.get(sendStep.campaignId) ?? 0)) continue;
    try {
      const rows = await deps.mailchimp.readSentTo(sendStep.campaignId);
      for (const r of rows) addresses.set(r.emailId, r.email);
      summary.newRows += await deps.store.insertNew(
        rows.map((r) => ({ campaignId: sendStep.campaignId, emailId: r.emailId, journeyId: sendStep.journeyId, stepId: sendStep.stepId, delivery: r.delivery })),
        disposition === 'run' ? 'pending' : 'dropped',
        iso(),
      );
      await deps.store.setCount(sendStep.campaignId, rows.length, iso());
      summary.read += 1;
    } catch (err) {
      summary.readFailed += 1;
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'journey-log-read-failed', environment: gate.environment, campaignId: sendStep.campaignId, error: errName(err), message: errText(err) }));
    }
  }

  if (disposition === 'dry-run') {
    console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'journey-log-run', environment: gate.environment, dryRun: true, ...summary }));
    return summary;
  }

  // 3. Log pending rows.
  const pending = await deps.store.listPending(settings.maxEntriesPerRun + 1);
  const work = pending.slice(0, settings.maxEntriesPerRun);
  summary.deferred = pending.length - work.length;
  for (let i = 0; i < work.length; i += 1) {
    const row = work[i]!;
    if (now() >= deadline) {
      summary.deferred += work.length - i;
      break;
    }
    try {
      const address = addresses.get(row.emailId) ?? await deps.mailchimp.readAddress(row.emailId);
      const items = address === null ? [] : await deps.monday.findPeople(settings.boardId, settings.emailColumns, address);
      if (items.length !== 1) {
        const status = items.length === 0 ? 'unmatched' : 'ambiguous';
        await deps.store.markUnresolved(row.campaignId, row.emailId, status);
        summary[status] += 1;
        continue;
      }
      const itemId = items[0]!;
      const sentAt = await deps.mailchimp.readSendTime(row.emailId, row.campaignId) ?? row.firstSeenAt;
      if (row.delivery === 'sent' && settings.lastJourneyEmailColumn !== null) {
        await deps.monday.advanceDate(settings.boardId, itemId, settings.lastJourneyEmailColumn, todayIn(TIME_ZONE, new Date(sentAt)));
      }
      await deps.monday.createTimelineItem({ itemId, customActivityId: settings.timelineActivityId, timestamp: sentAt, ...entryFor(row, byCampaign.get(row.campaignId)) });
      await deps.store.markLogged(row.campaignId, row.emailId, itemId, sentAt, iso());
      summary.logged += 1;
      if (row.delivery !== 'sent') summary.bounces += 1;
    } catch (err) {
      await deps.store.recordAttempt(row.campaignId, row.emailId).catch(() => undefined);
      if (deps.isOutage(err)) {
        // Every further call would fail the same way; the rest wait for the next hour.
        summary.outage = true;
        summary.deferred += work.length - i;
        break;
      }
      summary.failed += 1;
      if (row.attempts + 1 >= JOURNEY_LOG_MAX_ATTEMPTS) await deps.store.markUnresolved(row.campaignId, row.emailId, 'failed').catch(() => undefined);
      // log-safety: allow — emailId is Mailchimp's subscriber hash (the MD5 memberId), not an address.
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'journey-log-entry-failed', environment: gate.environment, campaignId: row.campaignId, memberId: row.emailId, attempts: row.attempts + 1, error: errName(err), message: errText(err) }));
    }
  }

  if (summary.readFailed > 0 || summary.failed > 0) {
    await deps.alert(`${prefix} ${summary.readFailed} Journey email reads and ${summary.failed} timeline entries failed; the next hourly run retries (see the journey-log-run log line)`);
  }
  console.log(JSON.stringify({ worker: 'mailchimp-sync', event: 'journey-log-run', environment: gate.environment, ...summary }));
  return summary;
}
