import { describe, it, expect, vi } from 'vitest';
import { listJourneyEmails, readSendTime, readSentTo, SentToShortReadError, type MailchimpReadOptions } from './mailchimp';

// Responses by path prefix (query string ignored), matched longest first.
function api(routes: Record<string, unknown>) {
  return vi.fn(async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname.replace('/3.0', '');
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => path === k);
    if (key === undefined) return new Response('', { status: 404 });
    const body = routes[key];
    return typeof body === 'number' ? new Response('', { status: body }) : new Response(JSON.stringify(body), { status: 200 });
  });
}
const opts = (fetchFn: unknown, pageSize?: number): MailchimpReadOptions => ({
  fetchFn: fetchFn as typeof fetch, apiBaseUrl: 'https://us9.api.mailchimp.com/3.0', apiKey: 'k-us9', audienceId: 'aud', pageSize,
});

const sendStep = (id: number, campaign: string, subject: string, sent: number) => ({
  id, step_type: 'action-send_email',
  action_details: { email: { id: campaign, emails_sent: sent, long_archive_url: `https://archive/${campaign}`, settings: { subject_line: subject } } },
});

describe('listJourneyEmails', () => {
  it("lists the audience's Journey emails with their position, skipping other audiences", async () => {
    const fetchFn = api({
      '/customer-journeys/journeys': { total_items: 2, journeys: [
        { id: 110, journey_name: 'Renewal', list_id: 'aud' },
        { id: 9, journey_name: 'Other audience', list_id: 'other' },
      ] },
      '/customer-journeys/journeys/110/steps': { steps: [
        { id: 1, step_type: 'trigger-tag_added' },
        sendStep(2, 'c1', 'Do you still love bikes?', 4),
        { id: 3, step_type: 'delay' },
        sendStep(4, 'c2', 'Time to renew', 1),
      ] },
    });
    const emails = await listJourneyEmails(opts(fetchFn), null);
    expect(emails).toEqual([
      { journeyId: 110, journeyName: 'Renewal', stepId: 2, campaignId: 'c1', subject: 'Do you still love bikes?', archiveUrl: 'https://archive/c1', position: 1, of: 2, emailsSent: 4 },
      expect.objectContaining({ stepId: 4, campaignId: 'c2', position: 2, of: 2, emailsSent: 1 }),
    ]);
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/journeys/9/'))).toBe(false);
    expect(await listJourneyEmails(opts(fetchFn), [111])).toEqual([]);
  });

  it('throws on a failed read rather than reading as no Journeys', async () => {
    await expect(listJourneyEmails(opts(api({ '/customer-journeys/journeys': 401 })), null)).rejects.toThrow('HTTP 401');
  });
});

describe('readSentTo', () => {
  it('pages through every recipient', async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      const rows = call === 1 ? [{ email_id: 'h1', email_address: 'a@x.org', status: 'sent' }] : [{ email_id: 'h2', email_address: 'b@x.org', status: 'hard' }];
      return new Response(JSON.stringify({ total_items: 2, sent_to: rows }), { status: 200 });
    });
    expect(await readSentTo(opts(fetchFn, 1), 'c1')).toEqual([
      { emailId: 'h1', email: 'a@x.org', delivery: 'sent' },
      { emailId: 'h2', email: 'b@x.org', delivery: 'hard' },
    ]);
  });

  it('fails a read that comes back short', async () => {
    const fetchFn = api({ '/reports/c1/sent-to': { total_items: 3, sent_to: [{ email_id: 'h1', email_address: 'a@x.org', status: 'sent' }] } });
    await expect(readSentTo(opts(fetchFn, 1000), 'c1')).rejects.toBeInstanceOf(SentToShortReadError);
  });
});

describe('readSendTime', () => {
  it("takes this email's sent action from the member's activity", async () => {
    const fetchFn = api({ '/lists/aud/members/h1/activity': { activity: [
      { action: 'open', campaign_id: 'c1', timestamp: '2026-11-18T23:00:00+00:00' },
      { action: 'sent', campaign_id: 'other', timestamp: '2026-11-01T00:00:00+00:00' },
      { action: 'sent', campaign_id: 'c1', timestamp: '2026-11-18T22:27:33+00:00' },
    ] } });
    expect(await readSendTime(opts(fetchFn), 'h1', 'c1')).toBe('2026-11-18T22:27:33+00:00');
    expect(await readSendTime(opts(fetchFn), 'h1', 'c9')).toBeNull();
    expect(await readSendTime(opts(fetchFn), 'gone', 'c1')).toBeNull();
  });
});
