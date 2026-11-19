// The Journey send log's Mailchimp reads (spec 2026-11-18-mailchimp-journey-send-log-design.md).
// Journey emails are `automation-email` campaigns found through the Customer Journeys endpoints
// (not /reports); each email's sent-to report lists who it went to, and the member's classic
// /activity holds the exact send time. All reads; this module never writes to Mailchimp.
import type { Delivery } from '../db/journeySends';

export interface MailchimpReadOptions {
  fetchFn: typeof fetch;
  apiBaseUrl: string;
  apiKey: string;
  audienceId: string;
  pageSize?: number;
}

export interface JourneyEmail {
  journeyId: number;
  journeyName: string;
  stepId: number;
  campaignId: string;
  subject: string;
  archiveUrl: string;
  // 1-based position among the Journey's send-email steps, and how many there are.
  position: number;
  of: number;
  emailsSent: number;
}

export interface SentToRow {
  emailId: string;
  // Only held in memory for this run, to find the People item; never stored or logged.
  email: string;
  delivery: Delivery;
}

// sent-to returned fewer rows than it said it holds; the read is retried next hour.
export class SentToShortReadError extends Error {}

const REQUEST_TIMEOUT_MS = 20_000;

async function get<T>(opts: MailchimpReadOptions, path: string, what: string): Promise<T | null> {
  const res = await opts.fetchFn(`${opts.apiBaseUrl}${path}`, {
    headers: { Authorization: `Basic ${btoa(`anystring:${opts.apiKey}`)}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mailchimp ${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface JourneysPage { total_items: number; journeys: { id: number; journey_name: string; list_id: string }[] }
interface StepsPage {
  steps: {
    id: number;
    step_type: string;
    action_details?: { email?: { id: string; emails_sent: number; long_archive_url?: string; archive_url?: string; settings?: { subject_line?: string } } };
  }[];
}

/** Every send-email step of the audience's Journeys (or of `journeyIds`, when given). */
export async function listJourneyEmails(opts: MailchimpReadOptions, journeyIds: readonly number[] | null): Promise<JourneyEmail[]> {
  const journeys: JourneysPage['journeys'] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = await get<JourneysPage>(opts, `/customer-journeys/journeys?count=${pageSize}&offset=${offset}`, 'list journeys');
    if (page === null) throw new Error('mailchimp list journeys: HTTP 404');
    journeys.push(...page.journeys);
    if (page.journeys.length === 0 || journeys.length >= page.total_items) break;
  }
  const wanted = journeys.filter((j) => j.list_id === opts.audienceId && (journeyIds === null || journeyIds.includes(j.id)));
  const emails: JourneyEmail[] = [];
  for (const journey of wanted) {
    const steps = await get<StepsPage>(opts, `/customer-journeys/journeys/${journey.id}/steps`, `journey ${journey.id} steps`);
    const sends = (steps?.steps ?? []).filter((s) => s.step_type === 'action-send_email' && s.action_details?.email?.id);
    sends.forEach((step, i) => {
      const email = step.action_details!.email!;
      emails.push({
        journeyId: journey.id,
        journeyName: journey.journey_name,
        stepId: step.id,
        campaignId: email.id,
        subject: email.settings?.subject_line ?? '',
        archiveUrl: email.long_archive_url ?? email.archive_url ?? '',
        position: i + 1,
        of: sends.length,
        emailsSent: email.emails_sent ?? 0,
      });
    });
  }
  return emails;
}

const DELIVERIES: readonly string[] = ['sent', 'hard', 'soft'];

/** Every recipient of one Journey email. */
export async function readSentTo(opts: MailchimpReadOptions, campaignId: string): Promise<SentToRow[]> {
  const pageSize = opts.pageSize ?? 1000;
  const rows: SentToRow[] = [];
  let total: number | null = null;
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const params = new URLSearchParams({
      count: String(pageSize), offset: String(offset),
      fields: 'total_items,sent_to.email_id,sent_to.email_address,sent_to.status',
    });
    const page = await get<{ total_items: number; sent_to: { email_id: string; email_address: string; status: string }[] }>(
      opts, `/reports/${campaignId}/sent-to?${params}`, `sent-to ${campaignId}`,
    );
    if (page === null) throw new Error(`mailchimp sent-to ${campaignId}: HTTP 404`);
    if (total !== null && page.total_items !== total) {
      throw new SentToShortReadError(`sent-to ${campaignId}: total changed from ${total} to ${page.total_items} while paging`);
    }
    total = page.total_items;
    for (const r of page.sent_to) {
      rows.push({ emailId: r.email_id, email: r.email_address, delivery: (DELIVERIES.includes(r.status) ? r.status : 'sent') as Delivery });
    }
    if (page.sent_to.length === 0) break;
  }
  if (rows.length !== total) throw new SentToShortReadError(`sent-to ${campaignId}: read ${rows.length} of ${total}`);
  return rows;
}

/** When this email was sent to this member, from the member's /activity; null if not found. */
export async function readSendTime(opts: MailchimpReadOptions, emailId: string, campaignId: string): Promise<string | null> {
  const data = await get<{ activity: { action: string; campaign_id?: string; timestamp: string }[] }>(
    opts, `/lists/${opts.audienceId}/members/${emailId}/activity?fields=activity.action,activity.campaign_id,activity.timestamp`,
    `member ${emailId} activity`,
  );
  const sends = (data?.activity ?? []).filter((a) => (a.action === 'sent' || a.action === 'bounce') && a.campaign_id === campaignId);
  if (sends.length === 0) return null;
  return sends.map((a) => a.timestamp).sort()[0] ?? null;
}

/** A member's address by subscriber hash, for a row left pending by an earlier run; null if gone. */
export async function readAddress(opts: MailchimpReadOptions, emailId: string): Promise<string | null> {
  const data = await get<{ email_address: string }>(opts, `/lists/${opts.audienceId}/members/${emailId}?fields=email_address`, `member ${emailId}`);
  return data?.email_address ?? null;
}
